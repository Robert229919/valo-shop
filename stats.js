// Statistiques de parties : historique, détails de match (résumés compacts mis en cache
// en mémoire + sur disque), agrégats (winrate, K/D, ACS, ADR, HS%…) et stats "fun".
// File d'attente globale pour /match-details afin de ne pas se faire rate-limiter par Riot.
import fs from 'node:fs';
import path from 'node:path';
import { liveContext, activeContext, getAssets } from './riot.js';
import { getGameAssets, getSeasons, getRank } from './live.js';

const QUEUES = {
  competitive: 'Compétition', unrated: 'Non classée', swiftplay: 'Vélocité', spikerush: 'Spike Rush',
  deathmatch: 'Combat à mort', ggteam: 'Escalade', hurm: 'Combat à mort par équipe', premier: 'Premier',
  newmap: 'Nouvelle carte', onefa: 'Réplication', snowball: 'Bataille de boules de neige',
  skirmish2v2: 'Escarmouche', '': 'Personnalisée',
};
const SUMMARY_VERSION = 1; // à incrémenter si le format du résumé change (invalide le cache disque)
const CACHE_DIR = path.join(process.env.APPDATA || path.join(process.env.HOME || '.', '.config'), 'valo-shop-viewer', 'match-cache');

const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;
const ratio = (a, b) => (b > 0 ? a / b : a);

// ---------- file d'attente des requêtes (2 en parallèle, 250 ms d'écart, pause sur 429) ----------
const MAX_CONCURRENT = 2;
const SPACING = 250;
const BACKOFF_429 = 10_000; // ctx.call n'expose pas Retry-After : délai par défaut
const queue = { active: 0, last: 0, pausedUntil: 0 };
const counters = { details: 0, history: 0, updates: 0, diskHits: 0, memHits: 0, retries429: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function acquire() {
  for (;;) {
    const now = Date.now();
    const wait = Math.max(queue.pausedUntil - now, queue.last + SPACING - now);
    if (queue.active < MAX_CONCURRENT && wait <= 0) { queue.active++; queue.last = now; return; }
    await sleep(Math.max(wait, 40));
  }
}
function retryAfterMs(e) {
  const m = String(e.retryAfter ?? e.message ?? '').match(/retry[- ]after\D{0,5}(\d+)/i);
  return m ? Math.min(Number(m[1]) * 1000, 60_000) : BACKOFF_429;
}
async function queuedCall(ctx, pathname) {
  for (let attempt = 0; ; attempt++) {
    await acquire();
    try {
      return await ctx.call(pathname);
    } catch (e) {
      if (e.riotStatus === 429 && attempt === 0) {
        counters.retries429++;
        queue.pausedUntil = Math.max(queue.pausedUntil, Date.now() + retryAfterMs(e));
        console.warn('[stats] 429, pause', pathname);
        continue;
      }
      throw e;
    } finally {
      queue.active--;
    }
  }
}

// ---------- mémo avec TTL + partage des promesses en cours ----------
const memo = new Map();
function cached(key, ttl, fn) {
  const hit = memo.get(key);
  if (hit && (hit.pending || Date.now() - hit.at < ttl)) return hit.promise;
  const entry = { at: Date.now(), pending: true };
  entry.promise = fn().then(
    (v) => { entry.pending = false; entry.at = Date.now(); return v; },
    (e) => { memo.delete(key); throw e; },
  );
  memo.set(key, entry);
  return entry.promise;
}

// ---------- historique / mises à jour RR (paginés par 20) ----------
async function paged(ctx, n, build, pick) {
  const out = [];
  for (let start = 0; start < n; start += 20) {
    const end = Math.min(start + 20, n);
    const r = await queuedCall(ctx, build(start, end));
    const items = pick(r) || [];
    out.push(...items);
    if (items.length < end - start) break;
  }
  return out.slice(0, n);
}
function getHistory(ctx, puuid, queueId, n) {
  return cached(`hist|${puuid}|${queueId}|${n}`, 120_000, () => {
    counters.history++;
    const q = queueId === 'all' ? '' : `&queue=${queueId}`;
    return paged(ctx, n, (s, e) => `/match-history/v1/history/${puuid}?startIndex=${s}&endIndex=${e}${q}`, (r) => r?.History);
  });
}
function getCompUpdates(ctx, puuid, n) {
  return cached(`upd|${puuid}|${n}`, 120_000, async () => {
    counters.updates++;
    try {
      const list = await paged(ctx, n,
        (s, e) => `/mmr/v1/players/${puuid}/competitiveupdates?startIndex=${s}&endIndex=${e}&queue=competitive`,
        (r) => r?.Matches);
      return new Map(list.map((m) => [m.MatchID, m]));
    } catch (e) {
      console.warn('[stats] competitiveupdates', e.message);
      return new Map();
    }
  });
}

// ---------- détails de match → résumé compact (tous les joueurs) ----------
function summarizeMatch(d) {
  const info = d.matchInfo || {};
  const players = (d.players || []).filter((p) => !p.isObserver);
  const teamOf = Object.fromEntries(players.map((p) => [p.subject, p.teamId]));
  const rounds = d.roundResults || [];
  const out = {};
  for (const p of players) {
    out[p.subject] = {
      team: p.teamId, agent: String(p.characterId || '').toLowerCase(), tier: p.competitiveTier || 0,
      score: p.stats?.score || 0, rounds: p.stats?.roundsPlayed || 0,
      k: p.stats?.kills || 0, d: p.stats?.deaths || 0, a: p.stats?.assists || 0,
      dmg: 0, hs: 0, bs: 0, ls: 0, fb: 0, aces: 0, multi: 0,
    };
  }
  // dégâts / tirs / premier sang / multi-kills, round par round
  for (const r of rounds) {
    let first = null;
    for (const ps of r.playerStats || []) {
      const me = out[ps.subject];
      if (!me) continue;
      const kills = (ps.kills || []).filter((k) => teamOf[k.victim] !== me.team);
      if (kills.length >= 5) me.aces++;
      if (kills.length >= 3) me.multi++;
      for (const k of ps.kills || []) if (!first || k.roundTime < first.roundTime) first = k;
      for (const dm of ps.damage || []) {
        if (dm.receiver === ps.subject || teamOf[dm.receiver] === me.team) continue; // pas les alliés
        me.dmg += dm.damage || 0;
        me.hs += dm.headshots || 0; me.bs += dm.bodyshots || 0; me.ls += dm.legshots || 0;
      }
    }
    if (first && out[first.killer]) out[first.killer].fb++;
  }
  const teams = Object.fromEntries((d.teams || []).map((t) => [t.teamId, {
    won: !!t.won, pts: t.numPoints ?? t.roundsWon ?? 0,
  }]));
  return {
    v: SUMMARY_VERSION,
    id: info.matchId,
    map: String(info.mapId || '').toLowerCase(),
    queue: info.queueID ?? '',
    start: info.gameStartMillis || 0,
    length: info.gameLengthMillis || 0,
    ranked: !!info.isRanked,
    hasRounds: rounds.length > 1 && (d.teams || []).length === 2,
    teams,
    players: out,
  };
}

const matchMem = new Map();
const cacheFile = (id) => path.join(CACHE_DIR, `${id.replace(/[^a-z0-9-]/gi, '')}.json`);
function getMatch(ctx, id) {
  const hit = matchMem.get(id);
  if (hit) { counters.memHits++; return hit; }
  const p = (async () => {
    try {
      const j = JSON.parse(await fs.promises.readFile(cacheFile(id), 'utf8'));
      if (j?.v === SUMMARY_VERSION) { counters.diskHits++; return j; }
    } catch { /* pas en cache */ }
    counters.details++;
    const raw = await queuedCall(ctx, `/match-details/v1/matches/${id}`);
    const s = summarizeMatch(raw);
    // seules les parties terminées sont immuables
    if (raw.matchInfo?.isCompleted !== false) {
      fs.promises.mkdir(CACHE_DIR, { recursive: true })
        .then(() => fs.promises.writeFile(cacheFile(id), JSON.stringify(s)))
        .catch((e) => console.warn('[stats] cache disque', e.message));
    } else {
      matchMem.delete(id);
    }
    return s;
  })();
  matchMem.set(id, p);
  p.catch(() => matchMem.delete(id));
  return p;
}
async function getMatches(ctx, ids) {
  // la file d'attente limite déjà le débit : on lance tout et on ignore les échecs isolés
  const res = await Promise.allSettled(ids.map((id) => getMatch(ctx, id)));
  return res.map((r, i) => {
    if (r.status === 'rejected') console.warn('[stats] match', ids[i], r.reason?.message);
    return r.status === 'fulfilled' ? r.value : null;
  }).filter(Boolean);
}

// ---------- vue d'une partie pour un joueur ----------
function matchItem(m, puuid, assets, upd) {
  const p = m.players[puuid];
  if (!p) return null;
  const mine = m.teams[p.team];
  const others = Object.entries(m.teams).filter(([id]) => id !== p.team).map(([, t]) => t);
  const won = !!mine?.won;
  const draw = !won && Object.keys(m.teams).length >= 2 && !others.some((t) => t.won);
  const map = assets.mapByPath[m.map];
  const agent = assets.agentById[p.agent];
  const shots = p.hs + p.bs + p.ls;
  const u0 = upd?.get(m.id);
  const u = u0 && !u0.IsPlacementMatch ? u0 : null; // placements : pas de RR
  const tierNum = u ? u.TierAfterUpdate : (m.ranked ? p.tier : 0);
  return {
    id: m.id,
    date: m.start,
    mode: QUEUES[m.queue] ?? m.queue,
    queue: m.queue,
    map: { name: map?.displayName || m.map.split('/').pop() || 'Carte', image: map?.listViewIcon || null },
    agent: { name: agent?.displayName || '?', icon: agent?.displayIcon || null, role: agent?.role?.displayName || null },
    won, draw,
    score: { ally: mine?.pts ?? 0, enemy: others.length ? Math.max(...others.map((t) => t.pts)) : 0 },
    kills: p.k, deaths: p.d, assists: p.a,
    kd: round2(ratio(p.k, p.d)),
    acs: Math.round(ratio(p.score, p.rounds)),
    adr: m.hasRounds && p.rounds ? Math.round(p.dmg / p.rounds) : null,
    hsPct: shots ? round1((p.hs / shots) * 100) : null,
    rrChange: u ? u.RankedRatingEarned : null,
    tierAfter: tierNum > 2 ? assets.tierByNum[tierNum] || null : null,
    lengthMs: m.length,
    // champs bruts pour les agrégats (retirés de la réponse)
    _p: p, _rounds: m.hasRounds,
  };
}

function aggregate(items) {
  if (!items.length) return null;
  const s = { k: 0, d: 0, a: 0, score: 0, rounds: 0, dmg: 0, dmgRounds: 0, hs: 0, shots: 0, fb: 0, aces: 0, multi: 0, len: 0 };
  let wins = 0, losses = 0, draws = 0;
  for (const it of items) {
    const p = it._p;
    if (it.won) wins++; else if (it.draw) draws++; else losses++;
    s.k += p.k; s.d += p.d; s.a += p.a; s.score += p.score; s.rounds += p.rounds;
    if (it._rounds) { s.dmg += p.dmg; s.dmgRounds += p.rounds; s.fb += p.fb; }
    s.hs += p.hs; s.shots += p.hs + p.bs + p.ls;
    s.aces += p.aces; s.multi += p.multi; s.len += it.lengthMs || 0;
  }
  return {
    matches: items.length, wins, losses, draws,
    winrate: round1((wins / items.length) * 100),
    kd: round2(ratio(s.k, s.d)),
    kda: round2(ratio(s.k + s.a, s.d)),
    kills: s.k, deaths: s.d, assists: s.a,
    hsPct: s.shots ? round1((s.hs / s.shots) * 100) : null,
    adr: s.dmgRounds ? Math.round(s.dmg / s.dmgRounds) : null,
    acs: s.rounds ? Math.round(s.score / s.rounds) : null,
    firstBloods: s.fb, aces: s.aces, multikills: s.multi,
    avgMatchMinutes: round1(s.len / items.length / 60000),
  };
}

function groupBy(items, keyFn) {
  const g = new Map();
  for (const it of items) {
    const k = keyFn(it);
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(it);
  }
  return [...g.values()];
}
function agentsOf(items) {
  return groupBy(items, (it) => it._p.agent).map((list) => {
    const a = aggregate(list);
    const { name, icon, role } = list[0].agent;
    return { name, icon, role, matches: a.matches, wins: a.wins, winrate: a.winrate, kd: a.kd, acs: a.acs };
  }).sort((x, y) => y.matches - x.matches || y.winrate - x.winrate);
}
function mapsOf(items) {
  return groupBy(items, (it) => it.map.name).map((list) => {
    const a = aggregate(list);
    return { name: list[0].map.name, image: list[0].map.image, matches: a.matches, wins: a.wins, winrate: a.winrate, kd: a.kd };
  }).sort((x, y) => y.matches - x.matches || y.winrate - x.winrate);
}
// items triés du plus récent au plus ancien
function streakOf(items) {
  if (!items.length || items[0].draw) return null;
  const type = items[0].won ? 'W' : 'L';
  let count = 0;
  for (const it of items) {
    if (it.draw || (it.won ? 'W' : 'L') !== type) break;
    count++;
  }
  return { type, count };
}
function longestWins(items) {
  let best = 0, cur = 0;
  for (const it of items) { cur = it.won ? cur + 1 : 0; best = Math.max(best, cur); }
  return best;
}
const publicItem = ({ _p, _rounds, lengthMs, ...rest }) => rest;

function coolStats({ summary, agents, maps, longest, best }) {
  // chaque entrée : [priorité, stat] ; on garde les 6 plus parlantes, dans l'ordre d'affichage
  const out = [];
  const add = (prio, label, value, detail) => out.push({ prio, i: out.length, s: { label, value, detail } });
  if (agents[0] && agents[0].matches >= 2) {
    add(1, 'Agent fétiche', agents[0].name, `${agents[0].matches} parties · ${agents[0].winrate}% de victoires`);
  }
  const eligible = maps.filter((m) => m.matches >= 2);
  if (eligible.length) {
    const worst = [...eligible].sort((a, b) => a.winrate - b.winrate || b.matches - a.matches)[0];
    if (worst.winrate < 50) add(2, 'Carte maudite', worst.name, `${worst.wins}/${worst.matches} victoires (${worst.winrate}%)`);
    const top = [...eligible].sort((a, b) => b.winrate - a.winrate || b.matches - a.matches)[0];
    if (top.winrate > 50 && top !== worst) add(8, 'Carte porte-bonheur', top.name, `${top.wins}/${top.matches} victoires (${top.winrate}%)`);
  }
  if (longest >= 2) add(3, 'Plus longue série', `${longest} victoires`, "d'affilée sur la période");
  if (summary.matches >= 3 && summary.firstBloods > 0) {
    add(4, 'Premier sang', `${round1(summary.firstBloods / summary.matches)} / partie`, `${summary.firstBloods} ouvertures au total`);
  }
  if (best) add(5, 'Partie record', `${best.acs} ACS`, `${best.kills}/${best.deaths}/${best.assists} en ${best.agent} sur ${best.map}`);
  if (summary.aces > 0) add(6, 'Aces', String(summary.aces), `${summary.multikills} rounds à 3 kills ou plus`);
  if (summary.hsPct != null && summary.matches >= 3) add(7, 'Précision', `${summary.hsPct}% HS`, 'des balles touchées à la tête');
  if (!summary.aces && summary.multikills > 0) add(9, 'Multi-kills', String(summary.multikills), 'rounds à 3 kills ou plus');
  return out.sort((x, y) => x.prio - y.prio).slice(0, 6).sort((x, y) => x.i - y.i).map((x) => x.s);
}

// ---------- chargement commun ----------
async function loadItems(ctx, puuid, queueId, n, withUpdates) {
  const [history, assets] = await Promise.all([getHistory(ctx, puuid, queueId, n), getGameAssets()]);
  const ids = history.map((h) => h.MatchID);
  const wantUpd = withUpdates && (queueId === 'competitive' || history.some((h) => h.QueueID === 'competitive'));
  const [matches, upd] = await Promise.all([
    getMatches(ctx, ids),
    wantUpd ? getCompUpdates(ctx, puuid, Math.max(20, n)) : Promise.resolve(null),
  ]);
  const items = matches.map((m) => matchItem(m, puuid, assets, upd)).filter(Boolean)
    .sort((a, b) => b.date - a.date);
  return { items, history, upd };
}

// ---------- exports ----------
export async function myStats({ queue: queueId = 'competitive', n = 20 } = {}) {
  n = Math.max(1, Math.min(Number(n) || 20, 100));
  // toujours le compte sélectionné dans l'appli
  const ctx = await activeContext();
  const puuid = ctx.puuid;
  return cached(`me|${puuid}|${queueId}|${n}`, 300_000, async () => {
    const assets = await getGameAssets();
    const [{ items, upd }, rank] = await Promise.all([
      loadItems(ctx, puuid, queueId, n, true),
      getSeasons(ctx).then((s) => getRank(ctx, puuid, s, assets.tierByNum)).catch(() => null),
    ]);
    const summary = aggregate(items);
    const agents = agentsOf(items);
    const maps = mapsOf(items);
    const longest = longestWins([...items].reverse());
    // meilleure partie (ACS) : on évite les modes sans rounds si possible
    const pool = items.some((it) => it._rounds) ? items.filter((it) => it._rounds) : items;
    const b = pool.reduce((x, y) => (!x || y.acs > x.acs ? y : x), null);
    const best = b ? {
      matchId: b.id, map: b.map.name, agent: b.agent.name, kills: b.kills, deaths: b.deaths,
      assists: b.assists, acs: b.acs, won: b.won, date: b.date,
    } : null;
    const comp = items.filter((it) => it.rrChange != null);
    return {
      queue: queueId,
      player: { puuid, rank },
      summary,
      agents,
      maps,
      streak: streakOf(items),
      longestWinStreak: longest,
      rrNet: upd && comp.length ? comp.reduce((t, it) => t + it.rrChange, 0) : null,
      best,
      cool: summary ? coolStats({ summary, agents, maps, longest, best }) : [],
      matches: items.map(publicItem),
    };
  });
}

export async function playerStats({ puuid, n = 5, queue: queueId = 'competitive' } = {}) {
  if (!puuid) throw new Error('puuid manquant');
  n = Math.max(1, Math.min(Number(n) || 5, 20));
  const ctx = await liveContext();
  return cached(`player|${puuid}|${queueId}|${n}`, 300_000, async () => {
    const empty = { puuid, queue: queueId, summary: null, agents: [], matches: [], streak: null };
    let q = queueId;
    let res;
    try {
      res = await loadItems(ctx, puuid, q, n, true);
      if (q === 'competitive' && res.history.length < 3) {
        q = 'all';
        res = await loadItems(ctx, puuid, q, n, true);
      }
    } catch (e) {
      // historique privé / indisponible
      if (e.riotStatus && e.riotStatus !== 429) { console.warn('[stats] historique', puuid, e.message); return { ...empty }; }
      throw e;
    }
    const { items } = res;
    if (!items.length) return { ...empty, queue: q };
    return {
      puuid,
      queue: q,
      summary: aggregate(items),
      agents: agentsOf(items).slice(0, 3),
      matches: items.map(publicItem),
      streak: streakOf(items),
    };
  });
}

// diagnostic (compteurs d'appels / cache)
export function statsDebug() {
  return { ...counters, cacheDir: CACHE_DIR, memMatches: matchMem.size, queueActive: queue.active };
}

// ---------- détail complet d'une partie : tableau, rounds, duels ----------
const DETAIL_VERSION = 1;
const detailFile = (id) => path.join(CACHE_DIR, `${id.replace(/[^a-z0-9-]/gi, '')}.full.json`);
const RESULT_FR = {
  Eliminated: 'Élimination', 'Bomb detonated': 'Spike explosé', 'Bomb defused': 'Spike désamorcé',
  'Round timer expired': 'Temps écoulé', Surrendered: 'Abandon',
};
const CEREMONY_FR = {
  CeremonyAce: 'Ace', CeremonyTeamAce: "Ace d'équipe", CeremonyClutch: 'Clutch', CeremonyFlawless: 'Sans faute',
  CeremonyThrifty: 'Éco gagnante', CeremonyCloser: 'Conclusion',
};

// version compacte et immuable du match brut (ce dont la vue détaillée a besoin)
function compactDetail(d) {
  const info = d.matchInfo || {};
  const players = (d.players || []).filter((p) => !p.isObserver);
  const rounds = (d.roundResults || []).map((r) => ({
    n: r.roundNum,
    win: r.winningTeam,
    role: r.winningTeamRole,
    res: r.roundResult,
    cer: r.roundCeremony,
    plant: r.bombPlanter || null,
    defuse: r.bombDefuser || null,
    site: r.plantSite || null,
    ps: Object.fromEntries((r.playerStats || []).map((ps) => [ps.subject, {
      sc: ps.score || 0,
      dmg: (ps.damage || []).map((x) => [x.receiver, x.damage || 0, x.headshots || 0, x.bodyshots || 0, x.legshots || 0]),
      eco: ps.economy ? [ps.economy.loadoutValue || 0, ps.economy.spent || 0, ps.economy.remaining || 0, ps.economy.weapon || ''] : null,
    }])),
    kills: (r.playerStats || []).flatMap((ps) => ps.kills || []).map((k) => ({
      t: k.roundTime, killer: k.killer, victim: k.victim,
      as: (k.assistants || []).map((a) => a.assistantPuuid || a),
      w: k.finishingDamage?.damageItem || '', wt: k.finishingDamage?.damageType || '',
    })).sort((a, b) => a.t - b.t),
  }));
  return {
    v: DETAIL_VERSION,
    id: info.matchId,
    map: String(info.mapId || '').toLowerCase(),
    queue: info.queueID ?? '',
    start: info.gameStartMillis || 0,
    length: info.gameLengthMillis || 0,
    teams: (d.teams || []).map((t) => ({ id: t.teamId, won: !!t.won, pts: t.numPoints ?? t.roundsWon ?? 0 })),
    players: players.map((p) => ({
      id: p.subject, name: p.gameName ? `${p.gameName}#${p.tagLine}` : null, team: p.teamId, party: p.partyId,
      agent: String(p.characterId || '').toLowerCase(), tier: p.competitiveTier || 0, level: p.accountLevel || null,
      score: p.stats?.score || 0, rp: p.stats?.roundsPlayed || 0,
      k: p.stats?.kills || 0, d: p.stats?.deaths || 0, a: p.stats?.assists || 0,
    })),
    rounds,
  };
}

const nameMem = new Map();
async function lookupNames(ctx, puuids) {
  const need = puuids.filter((id) => !nameMem.has(id));
  if (need.length) {
    try {
      const r = await ctx.call('/name-service/v2/players', { method: 'PUT', body: need });
      for (const n of r || []) nameMem.set(n.Subject, n.GameName ? `${n.GameName}#${n.TagLine}` : null);
    } catch (e) { console.warn('[stats] noms', e.message); }
  }
  return new Map(puuids.map((id) => [id, nameMem.get(id) || null]));
}

const detailMem = new Map();
function getDetail(ctx, id) {
  if (detailMem.has(id)) return detailMem.get(id);
  const p = (async () => {
    try {
      const j = JSON.parse(await fs.promises.readFile(detailFile(id), 'utf8'));
      if (j?.v === DETAIL_VERSION) return j;
    } catch { /* pas en cache */ }
    const raw = await queuedCall(ctx, `/match-details/v1/matches/${id}`);
    const c = compactDetail(raw);
    if (raw.matchInfo?.isCompleted !== false) {
      fs.promises.mkdir(CACHE_DIR, { recursive: true })
        .then(() => fs.promises.writeFile(detailFile(id), JSON.stringify(c)))
        .catch((e) => console.warn('[stats] cache détail', e.message));
    }
    return c;
  })();
  detailMem.set(id, p);
  p.catch(() => detailMem.delete(id));
  return p;
}

export async function matchDetail({ id, puuid }) {
  if (!/^[0-9a-f-]{36}$/i.test(id || '')) throw Object.assign(new Error('Partie invalide'), { status: 400 });
  const ctx = await activeContext();
  const [m, assets, { weapons }] = await Promise.all([getDetail(ctx, id), getGameAssets(), getAssets()]);
  // point de vue : le joueur demandé (panneau joueur) ou le compte sélectionné
  const self = puuid && m.players.some((p) => p.id === puuid) ? puuid : ctx.puuid;
  const me = m.players.find((p) => p.id === self);
  const allyTeam = me?.team || m.teams[0]?.id;
  const teamOf = Object.fromEntries(m.players.map((p) => [p.id, p.team]));
  const weaponName = Object.fromEntries(weapons.map((w) => [w.uuid.toLowerCase(), w.displayName]));
  const tierOf = (t) => (t > 2 ? assets.tierByNum[t] || null : null);
  const hasRounds = m.rounds.length > 1 && m.teams.length === 2;

  // cumuls par joueur sur toute la partie
  const acc = Object.fromEntries(m.players.map((p) => [p.id, {
    dmg: 0, hs: 0, bs: 0, ls: 0, fb: 0, fd: 0, kast: 0, multi: 0, aces: 0, plants: 0, defuses: 0,
  }]));
  const duels = {}; // duels[tueur][victime] = nombre d'éliminations
  const perRound = m.rounds.map((r) => {
    const killsBy = {}, died = new Set(), assisted = new Set(), traded = new Set();
    const enemyKills = r.kills.filter((k) => teamOf[k.killer] !== teamOf[k.victim]);
    for (const k of enemyKills) {
      killsBy[k.killer] = (killsBy[k.killer] || 0) + 1;
      died.add(k.victim);
      k.as.forEach((a) => assisted.add(a));
      (duels[k.killer] ||= {})[k.victim] = (duels[k.killer][k.victim] || 0) + 1;
    }
    // échange : mort vengée par un allié dans les 5 s
    for (const k of enemyKills) {
      if (enemyKills.some((x) => x.victim === k.killer && x.t >= k.t && x.t - k.t <= 5000)) traded.add(k.victim);
    }
    const first = enemyKills[0];
    if (first) { if (acc[first.killer]) acc[first.killer].fb++; if (acc[first.victim]) acc[first.victim].fd++; }
    if (r.plant && acc[r.plant]) acc[r.plant].plants++;
    if (r.defuse && acc[r.defuse]) acc[r.defuse].defuses++;
    const cells = {};
    for (const p of m.players) {
      const a = acc[p.id];
      const ps = r.ps[p.id];
      let dmg = 0;
      for (const [recv, dm, h, b, l] of ps?.dmg || []) {
        if (recv === p.id || teamOf[recv] === p.team) continue;
        dmg += dm; a.hs += h; a.bs += b; a.ls += l;
      }
      a.dmg += dmg;
      const k = killsBy[p.id] || 0;
      if (k >= 3) a.multi++;
      if (k >= 5) a.aces++;
      if (k || assisted.has(p.id) || !died.has(p.id) || traded.has(p.id)) a.kast++;
      cells[p.id] = { k, dmg, died: died.has(p.id), eco: ps?.eco?.[0] ?? null };
    }
    return {
      n: r.n + 1,
      ally: r.win === allyTeam,
      result: RESULT_FR[r.res] || r.res || '',
      ceremony: CEREMONY_FR[r.cer] || null,
      site: r.site,
      planter: r.plant, defuser: r.defuse,
      cells,
      feed: r.kills.map((k) => ({
        t: Math.round(k.t / 1000), killer: k.killer, victim: k.victim,
        weapon: weaponName[String(k.w).toLowerCase()]
          || (k.wt === 'Ability' ? 'Compétence' : k.wt === 'Bomb' ? 'Spike' : k.wt === 'Melee' ? 'Couteau' : ''),
        teamkill: teamOf[k.killer] === teamOf[k.victim],
      })),
    };
  });

  const map = assets.mapByPath[m.map];
  const players = m.players.map((p) => {
    const a = acc[p.id];
    const ag = assets.agentById[p.agent];
    const shots = a.hs + a.bs + a.ls;
    const rp = p.rp || Math.max(1, m.rounds.length);
    return {
      puuid: p.id, self: p.id === self, ally: p.team === allyTeam, party: p.party,
      name: p.name, level: p.level, rank: tierOf(p.tier),
      agent: ag ? { name: ag.displayName, icon: ag.displayIcon, role: ag.role?.displayName } : null,
      k: p.k, d: p.d, a: p.a, diff: p.k - p.d,
      kd: round2(ratio(p.k, p.d)),
      acs: Math.round(p.score / rp),
      adr: hasRounds ? Math.round(a.dmg / rp) : null,
      hsPct: shots ? round1((a.hs / shots) * 100) : null,
      kast: hasRounds ? Math.round((a.kast / rp) * 100) : null,
      fb: a.fb, fd: a.fd, multi: a.multi, aces: a.aces, plants: a.plants, defuses: a.defuses,
    };
  }).sort((x, y) => y.acs - x.acs);

  // noms : Riot ne les met plus dans les détails de partie
  const missing = players.filter((p) => !p.name).map((p) => p.puuid);
  if (missing.length) {
    const names = await lookupNames(ctx, missing);
    for (const p of players) if (!p.name) p.name = names.get(p.puuid) || null;
  }

  const allies = players.filter((p) => p.ally), enemies = players.filter((p) => !p.ally);
  const matrix = allies.map((a) => enemies.map((e) => ({
    kills: duels[a.puuid]?.[e.puuid] || 0, deaths: duels[e.puuid]?.[a.puuid] || 0,
  })));
  const ally = m.teams.find((t) => t.id === allyTeam), enemy = m.teams.find((t) => t.id !== allyTeam);
  return {
    id: m.id,
    map: map ? { name: map.displayName, image: map.listViewIcon, splash: map.splash } : { name: m.map.split('/').pop() },
    mode: QUEUES[m.queue] ?? m.queue,
    date: m.start,
    minutes: Math.round(m.length / 60000),
    score: { ally: ally?.pts ?? 0, enemy: enemy?.pts ?? 0 },
    won: !!ally?.won, draw: !ally?.won && !enemy?.won,
    hasRounds,
    players,
    rounds: perRound,
    duels: { allies: allies.map((p) => p.puuid), enemies: enemies.map((p) => p.puuid), matrix },
  };
}
