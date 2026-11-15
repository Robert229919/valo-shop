// Groupe (party) : mode de jeu, recherche de partie, lancement du jeu.
// Serveurs glz pour le groupe, API locale du Riot Client pour l'état du jeu et le lancement.
import { liveContext, localCall } from './riot.js';

const QUEUES = [
  ['competitive', 'Compétition'], ['unrated', 'Non classée'], ['swiftplay', 'Vélocité'],
  ['spikerush', 'Spike Rush'], ['deathmatch', 'Combat à mort'], ['ggteam', 'Escalade'],
  ['hurm', 'Combat à mort par équipe'], ['premier', 'Premier'],
];
const QUEUE_LABEL = Object.fromEntries(QUEUES);

const userError = (message) => Object.assign(new Error(message), { status: 400 });

// ---------- état local (Riot Client / jeu) ----------
async function localStatus() {
  try {
    const sessions = await localCall('GET', '/product-session/v1/external-sessions');
    const game = Object.values(sessions || {}).some((s) => s?.productId === 'valorant');
    return { clientRunning: true, gameRunning: game };
  } catch {
    return { clientRunning: false, gameRunning: false };
  }
}

// ---------- noms (cache) ----------
const nameCache = new Map();
async function names(ctx, puuids) {
  const missing = puuids.filter((p) => !nameCache.has(p));
  if (missing.length) {
    try {
      const r = await ctx.call('/name-service/v2/players', { method: 'PUT', body: missing });
      for (const n of r || []) nameCache.set(n.Subject, n.GameName ? `${n.GameName}#${n.TagLine}` : null);
    } catch (e) { console.warn('[party] noms', e.message); }
  }
  return Object.fromEntries(puuids.map((p) => [p, nameCache.get(p) ?? null]));
}

// ---------- erreurs Riot -> messages clairs ----------
function friendly(e, action) {
  if (e.status) return e; // déjà une erreur de l'appli (auth…)
  const msg = String(e.message || '');
  const code = e.riotStatus;
  if (/OWNER|LEADER|NOT_PARTY_OWNER/i.test(msg) || code === 403) {
    return userError(action === 'queue' ? 'Seul le chef de groupe peut changer de mode.' : 'Seul le chef de groupe peut lancer ou arrêter la recherche.');
  }
  if (/ELIGIB|QUEUE_NOT|NOT_ENABLED|DISABLED/i.test(msg)) return userError("Ce mode n'est pas disponible pour ton groupe.");
  if (/RESTRICT|PENALTY|BANNED|QUEUE_BAN/i.test(msg)) return userError('Recherche impossible : pénalité de file en cours.');
  if (/NOT_READY|READY/i.test(msg)) return userError("Tous les membres du groupe ne sont pas prêts.");
  if (code === 409 || /STATE|ALREADY/i.test(msg)) return userError("Action impossible dans l'état actuel du groupe.");
  if (code === 404) return userError("Groupe introuvable : VALORANT est-il bien lancé ?");
  return Object.assign(new Error(`Erreur Riot${code ? ` ${code}` : ''} : action refusée.`), { status: 502 });
}

// glz renvoie parfois un corps vide : on ignore l'erreur de parsing JSON
async function write(ctx, path, body, action) {
  try { await ctx.call(path, { method: 'POST', body, host: 'glz' }); } catch (e) {
    if (e instanceof SyntaxError) return;
    throw friendly(e, action);
  }
}

// ---------- lecture du groupe ----------
async function currentParty(ctx) {
  try {
    const p = await ctx.call(`/parties/v1/players/${ctx.puuid}`, { host: 'glz' });
    if (!p?.CurrentPartyID) return null;
    return await ctx.call(`/parties/v1/parties/${p.CurrentPartyID}`, { host: 'glz' });
  } catch (e) {
    if (e.riotStatus === 404) return null; // jeu pas lancé (ou pas encore connecté au groupe)
    throw e;
  }
}

const emptyQueues = () => QUEUES.map(([id, label]) => ({ id, label, eligible: false }));

export async function partyState() {
  const local = await localStatus();
  let ctx = null, party = null;
  try {
    ctx = await liveContext();
    // on n'interroge le groupe que si le jeu tourne (ou si on ne peut pas le savoir sans Riot Client)
    if (local.gameRunning || !local.clientRunning || ctx.source !== 'client') party = await currentParty(ctx);
  } catch (e) {
    if (local.clientRunning || e.status !== 401) console.warn('[party]', e.message);
  }
  if (!party) {
    return { ...local, inParty: false, partyId: null, state: null, queueId: null, queueLabel: null, queueSince: null, isOwner: false, canChangeQueue: false, members: [], queues: emptyQueues() };
  }

  const members = party.Members || [];
  const nameOf = await names(ctx, members.map((m) => m.Subject));
  const me = members.find((m) => m.Subject === ctx.puuid);
  const isOwner = !!me?.IsOwner;
  const queueId = party.MatchmakingData?.QueueID || null;
  const eligible = new Set(party.EligibleQueues || []);
  const since = Date.parse(party.QueueEntryTime || '');
  const matchmaking = party.State === 'MATCHMAKING';

  return {
    clientRunning: local.clientRunning,
    gameRunning: true, // le groupe répond : le jeu est forcément lancé
    inParty: true,
    partyId: party.ID,
    state: party.State || null,
    queueId,
    queueLabel: QUEUE_LABEL[queueId] || queueId || null,
    queueSince: matchmaking && since > 0 ? since : null,
    isOwner,
    canChangeQueue: isOwner && party.State === 'DEFAULT',
    members: members.map((m) => ({
      puuid: m.Subject,
      name: nameOf[m.Subject] || null,
      isOwner: !!m.IsOwner,
      isReady: !!m.IsReady,
      level: m.PlayerIdentity?.AccountLevel || null,
    })),
    queues: QUEUES.map(([id, label]) => ({ id, label, eligible: eligible.has(id) })),
  };
}

// Contexte + groupe obligatoires pour les actions
async function requireParty() {
  const ctx = await liveContext();
  const party = await currentParty(ctx);
  if (!party) throw userError("Lance VALORANT pour gérer ton groupe.");
  const me = (party.Members || []).find((m) => m.Subject === ctx.puuid);
  return { ctx, party, isOwner: !!me?.IsOwner };
}

export async function setQueue(queueId) {
  if (!QUEUE_LABEL[queueId]) throw userError('Mode de jeu inconnu.');
  const { ctx, party, isOwner } = await requireParty();
  if (!isOwner) throw userError('Seul le chef de groupe peut changer de mode.');
  if (party.State !== 'DEFAULT') throw userError('Arrête la recherche avant de changer de mode.');
  if (party.EligibleQueues && !party.EligibleQueues.includes(queueId)) {
    throw userError(`Le mode ${QUEUE_LABEL[queueId]} n'est pas disponible pour ton groupe.`);
  }
  if (party.MatchmakingData?.QueueID !== queueId) {
    await write(ctx, `/parties/v1/parties/${party.ID}/queue`, { queueId }, 'queue');
  }
  return partyState();
}

export async function startQueue() {
  const { ctx, party, isOwner } = await requireParty();
  if (!isOwner) throw userError('Seul le chef de groupe peut lancer la recherche.');
  if (party.State === 'MATCHMAKING') return partyState();
  if (party.State !== 'DEFAULT') throw userError("Impossible de lancer la recherche pour l'instant.");
  await write(ctx, `/parties/v1/parties/${party.ID}/matchmaking/join`, undefined, 'start');
  return partyState();
}

export async function stopQueue() {
  const { ctx, party, isOwner } = await requireParty();
  if (party.State !== 'MATCHMAKING') return partyState();
  if (!isOwner) throw userError('Seul le chef de groupe peut arrêter la recherche.');
  await write(ctx, `/parties/v1/parties/${party.ID}/matchmaking/leave`, undefined, 'stop');
  return partyState();
}

// Lance VALORANT via le Riot Client local
export async function launchGame() {
  const local = await localStatus();
  if (!local.clientRunning) throw userError("Le Riot Client n'est pas lancé : ouvre-le et connecte-toi.");
  if (local.gameRunning) throw userError('VALORANT est déjà lancé.');
  try {
    await localCall('POST', '/product-launcher/v1/products/valorant/patchlines/live');
  } catch (e) {
    if (e.code === 'NO_CLIENT') throw userError("Le Riot Client n'est pas lancé : ouvre-le et connecte-toi.");
    throw Object.assign(new Error(`Le Riot Client a refusé de lancer VALORANT${e.status ? ` (${e.status})` : ''}.`), { status: 502 });
  }
  return { ok: true };
}
