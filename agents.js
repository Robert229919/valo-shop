// Choix et verrouillage de l'agent pendant la sélection (pregame).
// Les appels d'écriture agissent sur la vraie partie : délai de 10 s imposé côté serveur.
import { liveContext } from './riot.js';
import { getGameAssets } from './live.js';

const AGENT_ENTITLEMENT = '01bb38e1-da47-4e6a-9b3d-945fe4655707';
export const MIN_DELAY = 10; // secondes entre la 1re vue de la partie et le droit d'agir
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const userError = (message, status = 400) => Object.assign(new Error(message), { status });

// ---------- délai : première vue de chaque partie ----------
const firstSeen = new Map(); // matchId -> ms
export function noteMatchSeen(matchId, now = Date.now()) {
  if (!matchId) return;
  if (!firstSeen.has(matchId)) firstSeen.set(matchId, now);
  if (firstSeen.size > 20) firstSeen.delete(firstSeen.keys().next().value); // pas de fuite
}
const waitLeft = (matchId, now) => Math.max(0, Math.ceil((firstSeen.get(matchId) + MIN_DELAY * 1000 - now) / 1000));

// ---------- agents possédés (cache court par compte) ----------
const ownedCache = new Map(); // puuid -> { at, ids:Set }
async function ownedAgents(ctx, assets) {
  const hit = ownedCache.get(ctx.puuid);
  if (hit && Date.now() - hit.at < 60_000) return hit.ids;
  const r = await ctx.call(`/store/v1/entitlements/{puuid}/${AGENT_ENTITLEMENT}`);
  const ids = new Set((r?.Entitlements || []).map((e) => String(e.ItemID).toLowerCase()));
  for (const a of Object.values(assets.agentById)) if (a.isBaseContent) ids.add(a.uuid.toLowerCase()); // agents de départ
  ownedCache.set(ctx.puuid, { at: Date.now(), ids });
  return ids;
}

// ---------- contexte (injectable pour les tests) ----------
async function getCtx(deps) {
  const ctx = deps.ctx || await liveContext();
  if (ctx.source !== 'client') throw userError("Seul le compte connecté au Riot Client peut choisir un agent : lance VALORANT avec ce compte.");
  return ctx;
}

// ---------- lecture de l'état ----------
async function currentMatch(ctx) {
  let matchId;
  try {
    matchId = (await ctx.call(`/pregame/v1/players/${ctx.puuid}`, { host: 'glz' }))?.MatchID;
  } catch (e) {
    if (e.riotStatus === 404) return null; // pas en sélection d'agent
    throw e;
  }
  if (!matchId) return null;
  const match = await ctx.call(`/pregame/v1/matches/${matchId}`, { host: 'glz' });
  return { matchId, match };
}

const INACTIVE = { active: false, matchId: null, phaseRemaining: null, minDelay: MIN_DELAY, selectableIn: 0, canAct: false, selected: null, locked: false, lockedAgent: null, agents: [] };

export async function agentSelectState(deps = {}) {
  const now = (deps.now || Date.now)();
  let ctx;
  try { ctx = await getCtx(deps); } catch (e) {
    if (deps.ctx) throw e;
    return { ...INACTIVE }; // pas de Riot Client / autre compte : simplement inactif
  }
  const cur = await currentMatch(ctx);
  if (!cur) return { ...INACTIVE };
  const { matchId, match } = cur;
  noteMatchSeen(matchId, now);

  const assets = deps.assets || await getGameAssets();
  const owned = await ownedAgents(ctx, assets);
  const players = match.AllyTeam?.Players || [];
  const me = players.find((p) => p.Subject === ctx.puuid);
  const lowId = (p) => String(p?.CharacterID || '').toLowerCase();
  const locked = me?.CharacterSelectionState === 'locked';
  const selected = me && me.CharacterSelectionState !== '' && lowId(me) ? lowId(me) : null;
  const takenBy = new Set(players.filter((p) => p.Subject !== ctx.puuid && p.CharacterSelectionState === 'locked').map(lowId));

  const agents = Object.values(assets.agentById).map((a) => {
    const id = a.uuid.toLowerCase();
    return { id, name: a.displayName, icon: a.displayIcon, role: a.role?.displayName || '', owned: owned.has(id), taken: takenBy.has(id), mine: selected === id };
  }).sort((a, b) => a.role.localeCompare(b.role, 'fr') || a.name.localeCompare(b.name, 'fr'));

  const selectableIn = waitLeft(matchId, now);
  return {
    active: true, matchId,
    phaseRemaining: match.PhaseTimeRemainingNS ? Math.round(match.PhaseTimeRemainingNS / 1e9) : null,
    minDelay: MIN_DELAY, selectableIn,
    canAct: selectableIn === 0 && !locked,
    selected, locked, lockedAgent: locked ? selected : null,
    agents,
  };
}

// ---------- écriture ----------
function friendly(e) {
  if (e.status) return e;
  const code = e.riotStatus;
  const msg = String(e.message || '');
  if (code === 404) return userError("La sélection d'agent est terminée.");
  if (/ALREADY|LOCKED/i.test(msg)) return userError('Un agent est déjà verrouillé.');
  if (/TAKEN|UNAVAILABLE|DUPLICATE/i.test(msg)) return userError('Cet agent est déjà pris par un coéquipier.');
  if (/NOT_OWN|ENTITL|FORBIDDEN/i.test(msg) || code === 403) return userError('Tu ne possèdes pas cet agent.');
  if (code === 400) return userError("Riot a refusé ce choix d'agent.");
  return Object.assign(new Error(`Erreur Riot${code ? ` ${code}` : ''} : choix refusé.`), { status: 502 });
}

async function act(kind, agentId, deps) {
  if (!UUID.test(String(agentId || ''))) throw userError('Agent invalide.');
  const id = String(agentId).toLowerCase();
  const now = (deps.now || Date.now)();
  const ctx = await getCtx(deps);
  let cur;
  try { cur = await currentMatch(ctx); } catch (e) { throw friendly(e); }
  if (!cur) throw userError("Tu n'es pas en sélection d'agent.");
  const { matchId, match } = cur;
  noteMatchSeen(matchId, now); // jamais plus tôt que la vraie ouverture : le délai ne peut qu'être plus long
  const left = waitLeft(matchId, now);
  if (left > 0) throw userError(`Patiente encore ${left} s avant de choisir ton agent.`);

  const assets = deps.assets || await getGameAssets();
  if (!assets.agentById[id]) throw userError('Agent inconnu.');
  const players = match.AllyTeam?.Players || [];
  const me = players.find((p) => p.Subject === ctx.puuid);
  if (me?.CharacterSelectionState === 'locked') throw userError('Ton agent est déjà verrouillé.');
  if (players.some((p) => p.Subject !== ctx.puuid && p.CharacterSelectionState === 'locked' && String(p.CharacterID).toLowerCase() === id)) {
    throw userError('Cet agent est déjà pris par un coéquipier.');
  }
  if (!(await ownedAgents(ctx, assets)).has(id)) throw userError('Tu ne possèdes pas cet agent.');

  try {
    await ctx.call(`/pregame/v1/matches/${matchId}/${kind}/${id}`, { method: 'POST', host: 'glz' });
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw friendly(e); // corps vide = succès
  }
  return agentSelectState(deps);
}

export const selectAgent = (agentId, deps = {}) => act('select', agentId, deps);
export const lockAgent = (agentId, deps = {}) => act('lock', agentId, deps);
