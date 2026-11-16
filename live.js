// Infos sur la partie en cours : sélection des agents (pregame) ou partie lancée (core-game).
// Rangs via /mmr, noms via name-service, skins via les loadouts de la partie.
import { liveContext, localPresences, getAssets, activePuuid } from './riot.js';
import { noteMatchSeen } from './agents.js';

const SOCKET_SKIN = 'bcef87d6-209b-46c6-8b19-fbe40bd95abc';
const SOCKET_CHROMA = '3ad1b2b2-acdb-4524-852f-954a76ddae0a';
const SHOWN_WEAPONS = {
  vandal: '9c82e19d-4575-0200-1a81-3eacf00cf872',
  phantom: 'ee8e8d15-496b-07ac-e5f6-8fae5d4c7b1a',
  operator: 'a03b24d3-4319-996d-0f8c-94bbfba1dfc7',
  melee: '2f59173c-4bed-b6c3-2191-dea9b58be9c7',
};
// Ordre du menu d'achat (loadout complet)
const BUY_ORDER = [
  '29a0cfab-485b-f5d5-779a-b59f85e204a8', '42da8ccc-40d5-affc-beec-15aa47b42eda', '44d4e95c-4157-0037-81b2-17841bf2e8e3', // Classic, Shorty, Frenzy
  '1baa85b4-4c70-1284-64bb-6481dfc3bb4e', '410b2e0b-4ceb-1321-1727-20858f7f3477', 'e336c6b8-418d-9340-d77f-7a9e4cfe0702', // Ghost, Bandit, Sheriff
  'f7e1b454-4ad4-1063-ec0a-159e56b58941', '462080d1-4035-2937-7c09-27aa2a5c27a7', // Stinger, Spectre
  '910be174-449b-c412-ab22-d0873436b21b', 'ec845bf4-4f79-ddda-a3da-0db3774b2794', // Bucky, Judge
  'ae3de142-4d85-2547-dd26-4e90bed35cf7', '4ade7faa-4cf1-8376-95ef-39884480959b', '8db0a1bf-4a50-832a-4566-faaaa6d250ca', // Bulldog, Guardian, Warden
  'ee8e8d15-496b-07ac-e5f6-8fae5d4c7b1a', '9c82e19d-4575-0200-1a81-3eacf00cf872', // Phantom, Vandal
  'c4883e50-4494-202c-3ec3-6b8a9284f00b', '5f0aaf7a-4289-3998-d5ff-eb9a5cf7ef5c', 'a03b24d3-4319-996d-0f8c-94bbfba1dfc7', // Marshal, Outlaw, Operator
  '55d8a0f4-4274-ca67-fe2c-06ab45efdf58', '63e6c2b6-4a8e-869c-3d4c-e38355226584', // Ares, Odin
  '2f59173c-4bed-b6c3-2191-dea9b58be9c7', // corps à corps
];
const CATEGORY_LABELS = {
  Sidearm: 'Armes de poing', SMG: 'Mitraillettes', Shotgun: 'Fusils à pompe', Rifle: 'Fusils',
  Sniper: 'Fusils de précision', Heavy: 'Armes lourdes', Melee: 'Corps à corps',
};
// Ep5 Acte 1 (ajout d'Ascendant) : avant cette date, les tiers 21+ sont décalés de 3
const ASCENDANT_RELEASE = Date.parse('2022-06-22T00:00:00Z');

const QUEUES = {
  competitive: 'Compétition', unrated: 'Non classée', swiftplay: 'Vélocité', spikerush: 'Spike Rush',
  deathmatch: 'Combat à mort', ggteam: 'Escalade', hurm: 'Combat à mort par équipe', premier: 'Premier',
  newmap: 'Nouvelle carte', onefa: 'Réplication', snowball: 'Bataille de boules de neige', '': 'Partie personnalisée',
};

// ---------- assets du jeu (cartes, agents, rangs) ----------
let gameAssets = null;
export async function getGameAssets() {
  if (gameAssets) return gameAssets;
  const j = (u) => fetch(u).then((r) => r.json()).then((r) => r.data);
  const [maps, agents, tiers] = await Promise.all([
    j('https://valorant-api.com/v1/maps?language=fr-FR'),
    j('https://valorant-api.com/v1/agents?isPlayableCharacter=true&language=fr-FR'),
    j('https://valorant-api.com/v1/competitivetiers?language=fr-FR'),
  ]);
  const latest = tiers[tiers.length - 1];
  gameAssets = {
    mapByPath: Object.fromEntries(maps.map((m) => [m.mapUrl?.toLowerCase(), m])),
    agentById: Object.fromEntries(agents.map((a) => [a.uuid.toLowerCase(), a])),
    tierByNum: Object.fromEntries(latest.tiers.map((t) => [t.tier, {
      tier: t.tier, name: t.tierName, icon: t.smallIcon || t.largeIcon, color: '#' + (t.color || 'ffffffff').slice(0, 6),
    }])),
  };
  return gameAssets;
}

// ---------- saisons (acte en cours / précédent) ----------
let seasonsCache = null;
export async function getSeasons(ctx) {
  if (seasonsCache && Date.now() - seasonsCache.at < 3600_000) return seasonsCache;
  const content = await ctx.call('/content-service/v3/content', { host: 'shared' });
  const acts = (content.Seasons || []).filter((s) => s.Type === 'act')
    .map((s) => ({ id: s.ID, active: s.IsActive, start: Date.parse(s.StartTime), name: s.Name }))
    .sort((a, b) => a.start - b.start);
  const idx = acts.findIndex((a) => a.active);
  seasonsCache = {
    at: Date.now(),
    current: acts[idx]?.id,
    previous: idx > 0 ? acts[idx - 1].id : null,
    startById: Object.fromEntries(acts.map((a) => [a.id, a.start])),
  };
  return seasonsCache;
}

// ---------- rangs (mis en cache 5 min par joueur) ----------
const mmrCache = new Map();
export async function getRank(ctx, puuid, seasons, tierByNum) {
  const hit = mmrCache.get(puuid);
  if (hit && Date.now() - hit.at < 300_000) return hit.data;
  let data = null;
  try {
    const mmr = await ctx.call(`/mmr/v1/players/${puuid}`);
    const bySeason = mmr?.QueueSkills?.competitive?.SeasonalInfoBySeasonID || {};
    const cur = bySeason[seasons.current] || null;
    const prev = seasons.previous ? bySeason[seasons.previous] : null;
    // pic : meilleur tier gagné sur toutes les saisons (WinsByTier), avec correction avant Ascendant
    let peak = 0;
    for (const [sid, info] of Object.entries(bySeason)) {
      const old = (seasons.startById[sid] ?? Infinity) < ASCENDANT_RELEASE;
      for (const t of Object.keys(info.WinsByTier || {}).map(Number)) {
        const fixed = old && t >= 21 ? t + 3 : t;
        if (fixed > peak) peak = fixed;
      }
    }
    const tier = (n) => (n > 2 ? tierByNum[n] || null : null);
    data = {
      current: tier(cur?.CompetitiveTier || 0),
      rr: cur?.CompetitiveTier ? cur.RankedRating : null,
      games: cur?.NumberOfGames || 0,
      wins: cur?.NumberOfWinsWithPlacements ?? cur?.NumberOfWins ?? 0,
      previous: tier(prev?.CompetitiveTier || 0),
      peak: tier(peak),
    };
  } catch (e) {
    console.warn('[live] mmr', e.message);
  }
  mmrCache.set(puuid, { at: Date.now(), data });
  return data;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// ---------- skins portés dans la partie ----------
const skinLabel = (skin) => skin.displayName.replace(/^.*?\((.+)\)\s*$/, '$1');
// Loadout complet d'un joueur, dans l'ordre du menu d'achat
function fullLoadout(lo, weaponById, skinById) {
  return BUY_ORDER.map((weaponId) => {
    const w = weaponById.get(weaponId);
    if (!w) return null;
    const item = lo.Items?.[weaponId] || lo.Items?.[weaponId.toUpperCase()];
    const skin = skinById.get(item?.Sockets?.[SOCKET_SKIN]?.Item?.ID) || w.skins.find((s) => s.uuid === w.defaultSkinUuid);
    const isDefault = !skin || skin.uuid === w.defaultSkinUuid;
    const chroma = skin?.chromas.find((c) => c.uuid === item?.Sockets?.[SOCKET_CHROMA]?.Item?.ID);
    return {
      weaponId,
      weapon: { name: w.displayName, icon: w.displayIcon, category: CATEGORY_LABELS[String(w.category).split('::').pop()] || null },
      skin: {
        name: skin ? skinLabel(skin) : w.displayName,
        image: isDefault ? w.displayIcon : (chroma?.fullRender || skin.displayIcon || skin.chromas[0]?.fullRender || skin.levels[0]?.displayIcon || w.displayIcon),
        isDefault,
      },
    };
  }).filter(Boolean);
}

async function skinsByPlayer(ctx, kind, matchId) {
  const out = {}, loadouts = {};
  try {
    const r = await ctx.call(`/${kind}/v1/matches/${matchId}/loadouts`, { host: 'glz' });
    const { weapons } = await getAssets();
    const skinById = new Map();
    const weaponById = new Map(weapons.map((w) => [w.uuid.toLowerCase(), w]));
    for (const w of weapons) for (const s of w.skins) skinById.set(s.uuid, s);
    // core-game : Loadouts[].Loadout.Subject ; pregame : Loadouts[] alignés sur l'ordre des joueurs
    (r.Loadouts || []).forEach((entry, i) => {
      const lo = entry.Loadout || entry;
      const subject = lo.Subject || i;
      const pick = {};
      for (const [key, weaponId] of Object.entries(SHOWN_WEAPONS)) {
        const item = lo.Items?.[weaponId];
        const skin = skinById.get(item?.Sockets?.[SOCKET_SKIN]?.Item?.ID);
        if (!skin) continue;
        const chromaId = item.Sockets?.[SOCKET_CHROMA]?.Item?.ID;
        const chroma = skin.chromas.find((c) => c.uuid === chromaId);
        pick[key] = {
          name: skinLabel(skin),
          image: chroma?.fullRender || skin.displayIcon || skin.chromas[0]?.fullRender || skin.levels[0]?.displayIcon,
        };
      }
      out[subject] = pick;
      loadouts[subject] = fullLoadout(lo, weaponById, skinById);
    });
  } catch (e) {
    console.warn('[live] loadouts', e.message);
  }
  return { skins: out, loadouts };
}

// ---------- score + groupes via le Riot Client local ----------
function deepFind(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) { const r = deepFind(v, key); if (r !== undefined) return r; }
  return undefined;
}
async function presenceInfo(selfPuuid) {
  const list = await localPresences();
  if (!list) return null;
  const parsed = list.filter((p) => p.product === 'valorant' && p.private).map((p) => {
    try { return { puuid: p.puuid, data: JSON.parse(Buffer.from(p.private, 'base64').toString('utf8')) }; } catch { return null; }
  }).filter(Boolean);
  const me = parsed.find((p) => p.puuid === selfPuuid);
  if (!me) return null;
  const partyOf = (d) => deepFind(d, 'partyId');
  const myParty = partyOf(me.data);
  return {
    ally: deepFind(me.data, 'partyOwnerMatchScoreAllyTeam'),
    enemy: deepFind(me.data, 'partyOwnerMatchScoreEnemyTeam'),
    partyMembers: new Set(parsed.filter((p) => myParty && partyOf(p.data) === myParty).map((p) => p.puuid)),
  };
}

function serverName(pod) {
  const m = String(pod || '').match(/gp-([a-z]+(?:-[a-z]+)*)-\d+$/i);
  if (!m) return null;
  return m[1].split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

// ---------- point d'entrée ----------
export async function buildLive() {
  const ctx = await liveContext();
  const self = ctx.puuid;
  // le compte sélectionné dans l'appli n'est pas celui du Riot Client : seulement ses stats
  const selected = activePuuid();
  if (ctx.source !== 'client' || (selected && selected !== self)) {
    return { state: 'offline', source: ctx.source, reason: ctx.source === 'client' ? 'other-account' : 'no-client' };
  }

  let kind = null, matchId = null;
  for (const k of ['core-game', 'pregame']) {
    try {
      const r = await ctx.call(`/${k}/v1/players/${self}`, { host: 'glz' });
      if (r?.MatchID) { kind = k; matchId = r.MatchID; break; }
    } catch (e) {
      if (e.riotStatus !== 404) throw e;
    }
  }
  if (!matchId) return { state: 'menu', source: ctx.source };

  const match = await ctx.call(`/${kind}/v1/matches/${matchId}`, { host: 'glz' });
  if (kind === 'pregame') noteMatchSeen(matchId); // départ du délai avant le choix d'agent
  const [assets, seasons, { skins, loadouts }, presence] = await Promise.all([
    getGameAssets(), getSeasons(ctx), skinsByPlayer(ctx, kind, matchId), presenceInfo(self),
  ]);

  // joueurs : pregame = seulement ton équipe ; core-game = tout le monde
  const raw = kind === 'pregame'
    ? (match.AllyTeam?.Players || []).map((p) => ({ ...p, TeamID: match.AllyTeam.TeamID }))
    : (match.Players || []);
  const myTeam = raw.find((p) => p.Subject === self)?.TeamID;

  let names = {};
  try {
    const r = await ctx.call('/name-service/v2/players', { method: 'PUT', body: raw.map((p) => p.Subject) });
    names = Object.fromEntries(r.map((n) => [n.Subject, n.GameName ? `${n.GameName}#${n.TagLine}` : null]));
  } catch (e) { console.warn('[live] names', e.message); }

  const ranks = await mapLimit(raw, 4, (p) => getRank(ctx, p.Subject, seasons, assets.tierByNum));

  const players = raw.map((p, i) => {
    const agent = assets.agentById[String(p.CharacterID || '').toLowerCase()];
    const isSelf = p.Subject === self;
    const id = p.PlayerIdentity || {};
    // on respecte le mode streamer : nom masqué pour les joueurs incognito
    const hidden = id.Incognito && !isSelf;
    return {
      puuid: p.Subject,
      self: isSelf,
      ally: p.TeamID === myTeam,
      team: p.TeamID,
      name: hidden ? null : names[p.Subject] || null,
      level: (id.HideAccountLevel && !isSelf) || !id.AccountLevel ? null : id.AccountLevel, // 0 en pregame pour soi
      agent: agent ? { name: agent.displayName, icon: agent.displayIcon, role: agent.role?.displayName } : null,
      lock: kind === 'pregame' ? (p.CharacterSelectionState || '') : 'locked',
      rank: ranks[i],
      party: presence?.partyMembers?.has(p.Subject) || false,
      skins: skins[p.Subject] || skins[i] || {},
      loadout: loadouts[p.Subject] || loadouts[i] || [],
    };
  });

  const mapPath = String(match.MapID || '').toLowerCase();
  const map = assets.mapByPath[mapPath];
  const queue = match.MatchmakingData?.QueueID ?? match.QueueID ?? '';
  const sortTeam = (list) => list.sort((a, b) => (b.self - a.self) || ((b.rank?.current?.tier || 0) - (a.rank?.current?.tier || 0)));

  return {
    state: kind === 'pregame' ? 'pregame' : 'ingame',
    source: ctx.source,
    map: map ? { name: map.displayName, splash: map.splash, list: map.listViewIcon } : { name: mapPath.split('/').pop() || 'Carte' },
    mode: QUEUES[queue] ?? queue,
    server: serverName(match.GamePodID),
    phaseRemaining: kind === 'pregame' && match.PhaseTimeRemainingNS ? Math.round(match.PhaseTimeRemainingNS / 1e9) : null,
    // en pregame, le score de la présence est périmé
    score: kind !== 'pregame' && presence && presence.ally != null ? { ally: presence.ally, enemy: presence.enemy } : null,
    allySide: myTeam === 'Blue' ? 'Défense en 1re mi-temps' : myTeam === 'Red' ? 'Attaque en 1re mi-temps' : null,
    allies: sortTeam(players.filter((p) => p.ally)),
    enemies: sortTeam(players.filter((p) => !p.ally)),
  };
}
