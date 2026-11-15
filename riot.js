// Accès aux API (non officielles) de Riot / Valorant.
// Trois façons de s'authentifier :
//   1. "riot"  : fenêtre de connexion intégrée (Electron), une partition de cookies par compte.
//   2. "local" : lit le lockfile du Riot Client (déjà connecté) et récupère les tokens
//      via son API locale. Aucun mot de passe ne transite par cette appli.
//   3. "url"   : l'utilisateur se connecte sur la vraie page Riot, puis colle l'URL de
//      redirection (qui contient access_token + id_token).
// Plusieurs comptes peuvent être connectés en même temps ; un seul est "actif".

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';

const LOCALAPPDATA = process.env.LOCALAPPDATA || '';
const LOCKFILE = path.join(LOCALAPPDATA, 'Riot Games', 'Riot Client', 'Config', 'lockfile');
const SHOOTER_LOG = path.join(LOCALAPPDATA, 'VALORANT', 'Saved', 'Logs', 'ShooterGame.log');

export const ITEM_TYPES = {
  skinLevel: 'e7c63390-eda7-46e0-bb7a-a6abdacd2433',
  skinChroma: '3ad1b2b2-acdb-4524-852f-954a76ddae0a',
};
export const CURRENCIES = {
  vp: '85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741',
  radianite: 'e59aa87c-4cbf-517a-5983-6e81511be9b7',
  kingdom: '85ca954a-41f2-ce94-9b45-8ca3dd39a00d',
};

export const LOGIN_URL =
  'https://auth.riotgames.com/authorize?redirect_uri=https%3A%2F%2Fplayvalorant.com%2Fopt_in' +
  '&client_id=play-valorant-web-prod&response_type=token%20id_token&nonce=1&scope=account%20openid';

const CLIENT_PLATFORM = Buffer.from(JSON.stringify({
  platformType: 'PC',
  platformOS: 'Windows',
  platformOSVersion: '10.0.19042.1.256.64bit',
  platformChipset: 'Unknown',
})).toString('base64');

const REGION_TO_SHARD = { na: 'na', latam: 'na', br: 'na', eu: 'eu', ap: 'ap', kr: 'kr', pbe: 'pbe' };

// ---------- comptes (tokens en mémoire uniquement ; seules les métadonnées sont persistées) ----------
// Compte : { id, puuid, name, region, partition, mode, session, needsRelogin, renewing }
//   partition = partition Electron des cookies Riot (null pour les modes local / url, non persistés)
const LEGACY_PARTITION = 'persist:riot'; // ancienne partition unique, migrée en premier compte
const accounts = new Map();
let activeId = null;
let persistedActive = null; // dernier compte persisté actif (pour accounts.json)

// Fournis par l'app Electron :
//  - reauthProvider({ interactive, partition }) -> URL de redirection (#access_token=...) en réutilisant
//    les cookies de la partition ; interactive=true affiche la fenêtre de connexion si besoin.
//  - partitionCleaner(partition) -> efface les cookies / données de la partition.
//  - store { load() -> {active, accounts} | null, save(data) } -> accounts.json (métadonnées seulement).
let reauthProvider = null;
let partitionCleaner = null;
let store = null;
export function setReauthProvider(fn, onClearPartition) { reauthProvider = fn; partitionCleaner = onClearPartition; }
export function setAccountStore(s) { store = s; }
export function hasReauthProvider() { return !!reauthProvider; }

const newId = () => crypto.randomBytes(4).toString('hex');
const activeAccount = () => accounts.get(activeId) || null;
const byPuuid = (puuid) => [...accounts.values()].find((a) => puuid && a.puuid === puuid) || null;
const authError = (message, accountId) => Object.assign(new Error(message), { status: 401, ...(accountId ? { accountId } : {}) });
const mustBeActive = () => {
  const a = activeAccount();
  if (!a) throw authError('Non connecté');
  return a;
};
const reloginMessage = (acc) => (acc.name ? `Le compte ${acc.name} doit se reconnecter.` : 'Ce compte doit se reconnecter.');

async function dropPartition(partition) {
  if (!partition) return;
  try { await partitionCleaner?.(partition); } catch (e) { console.warn('[partition]', e.message); }
}

function persist() {
  if (!store) return;
  const list = [...accounts.values()].filter((a) => a.partition).map((a) => ({
    id: a.id, puuid: a.puuid, name: a.name, region: a.region, partition: a.partition,
  }));
  if (activeAccount()?.partition) persistedActive = activeId;
  if (!list.some((a) => a.id === persistedActive)) persistedActive = list[0]?.id ?? null;
  try { store.save({ active: persistedActive, accounts: list }); } catch (e) { console.warn('[accounts]', e.message); }
}

export function listAccounts() {
  return [...accounts.values()].map((a) => ({
    id: a.id,
    name: a.name,
    region: a.region,
    mode: a.mode,
    active: a.id === activeId,
    connected: !!a.session && !a.needsRelogin,
    relogin: !!a.needsRelogin,
  }));
}
export function getActiveId() { return activeId; }
export function getSession() { return activeAccount()?.session || null; }

// Un seul flux interactif (fenêtre de connexion) à la fois
let interactiveBusy = false;
async function exclusive(fn) {
  if (interactiveBusy) throw Object.assign(new Error('Une connexion est déjà en cours.'), { status: 409 });
  interactiveBusy = true;
  try { return await fn(); } finally { interactiveBusy = false; }
}

function decodeJwt(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  } catch { return {}; }
}

// ---------- API locale du Riot Client (certificat auto-signé) ----------
function readLockfile() {
  if (!fs.existsSync(LOCKFILE)) {
    throw new Error("Riot Client introuvable (pas de lockfile). Lance le Riot Client et connecte-toi.");
  }
  const [name, pid, port, password, protocol] = fs.readFileSync(LOCKFILE, 'utf8').trim().split(':');
  return { name, pid, port, password, protocol };
}

function localRequest(pathname) {
  const lock = readLockfile();
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: '127.0.0.1',
      port: lock.port,
      path: pathname,
      method: 'GET',
      rejectUnauthorized: false, // certificat auto-signé du Riot Client, uniquement sur 127.0.0.1
      headers: { Authorization: 'Basic ' + Buffer.from(`riot:${lock.password}`).toString('base64') },
      timeout: 5000,
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`Riot Client a répondu ${res.statusCode} sur ${pathname}. Es-tu bien connecté dans le Riot Client ?`));
        }
        try { resolve(JSON.parse(body)); } catch { reject(new Error('Réponse invalide du Riot Client')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Timeout Riot Client')));
    req.on('error', (e) => reject(new Error(
      e.code === 'ECONNREFUSED'
        ? "Le Riot Client n'est pas lancé (le lockfile est périmé). Lance-le et connecte-toi."
        : `Erreur Riot Client : ${e.message}`)));
    req.end();
  });
}

// Appel générique à l'API locale du Riot Client (méthode + corps JSON).
// Renvoie le JSON (ou null si vide) ; erreur avec .status (HTTP) ou .code ('NO_CLIENT').
export function localCall(method, pathname, body) {
  let lock;
  try { lock = readLockfile(); } catch (e) { return Promise.reject(Object.assign(e, { code: 'NO_CLIENT' })); }
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: '127.0.0.1',
      port: lock.port,
      path: pathname,
      method,
      rejectUnauthorized: false, // certificat auto-signé, uniquement sur 127.0.0.1
      headers: {
        Authorization: 'Basic ' + Buffer.from(`riot:${lock.password}`).toString('base64'),
        ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: 5000,
    }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }
        if (res.statusCode >= 400) {
          return reject(Object.assign(new Error(`Riot Client a répondu ${res.statusCode} sur ${pathname}`), { status: res.statusCode, data }));
        }
        resolve(data);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Timeout Riot Client')));
    req.on('error', (e) => reject(Object.assign(new Error(
      e.code === 'ECONNREFUSED' ? "Le Riot Client n'est pas lancé." : `Erreur Riot Client : ${e.message}`),
    { code: e.code === 'ECONNREFUSED' ? 'NO_CLIENT' : e.code })));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function regionFromLog() {
  try {
    const log = fs.readFileSync(SHOOTER_LOG, 'utf8');
    const m = log.match(/https:\/\/glz-([a-z0-9]+)-1\.([a-z]+)\.a\.pvp\.net/);
    if (m) return { region: m[1], shard: m[2] };
  } catch { /* pas de log */ }
  return null;
}

async function regionFromLocalSessions() {
  try {
    const sessions = await localRequest('/product-session/v1/external-sessions');
    for (const s of Object.values(sessions)) {
      const args = s?.launchConfiguration?.arguments || [];
      const dep = args.find((a) => a.startsWith('-ares-deployment='));
      if (dep) {
        const region = dep.split('=')[1];
        return { region, shard: REGION_TO_SHARD[region] || region };
      }
    }
  } catch { /* Valorant pas lancé */ }
  return null;
}

// ---------- construction d'une session (sans toucher à la liste des comptes) ----------
async function sessionFromLocal(regionOverride) {
  const tok = await localRequest('/entitlements/v1/token');
  if (!tok.accessToken || !tok.token) {
    throw new Error("Le Riot Client n'a pas renvoyé de token. Connecte-toi dans le Riot Client.");
  }
  let reg = regionOverride
    ? { region: regionOverride, shard: REGION_TO_SHARD[regionOverride] || regionOverride }
    : (await regionFromLocalSessions()) || regionFromLog();
  if (!reg) throw new Error('Région introuvable : choisis-la manuellement.');
  const claims = decodeJwt(tok.accessToken);
  return {
    mode: 'local',
    accessToken: tok.accessToken,
    entToken: tok.token,
    puuid: tok.subject || claims.sub,
    region: reg.region,
    shard: reg.shard,
    expiresAt: (claims.exp || 0) * 1000,
  };
}

async function sessionFromUrl(rawUrl, regionOverride, mode = 'url') {
  let fragment = String(rawUrl || '').trim();
  const hashIdx = fragment.indexOf('#');
  if (hashIdx >= 0) fragment = fragment.slice(hashIdx + 1);
  const params = new URLSearchParams(fragment);
  const accessToken = params.get('access_token');
  const idToken = params.get('id_token');
  if (!accessToken) throw new Error("Pas d'access_token dans l'URL collée. Copie bien toute l'URL après la redirection.");

  const entRes = await fetch('https://entitlements.auth.riotgames.com/api/token/v1', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!entRes.ok) throw new Error(`Entitlements refusés (${entRes.status}). Le token a peut-être expiré, reconnecte-toi.`);
  const { entitlements_token: entToken } = await entRes.json();

  let region = regionOverride;
  if (!region && idToken) {
    const geo = await fetch('https://riot-geo.pas.si.riotgames.com/pas/v1/product/valorant', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id_token: idToken }),
    });
    if (geo.ok) region = (await geo.json())?.affinities?.live;
  }
  if (!region) region = regionFromLog()?.region;
  if (!region) throw new Error('Région introuvable : choisis-la manuellement.');

  const claims = decodeJwt(accessToken);
  return {
    mode,
    accessToken,
    entToken,
    puuid: claims.sub,
    region,
    shard: REGION_TO_SHARD[region] || region,
    expiresAt: (claims.exp || 0) * 1000,
  };
}

// Session "riot" silencieuse à partir des cookies de la partition du compte
async function sessionFromPartition(partition, region) {
  if (!reauthProvider) throw new Error("La connexion Riot intégrée n'est dispo que dans l'app (npm run app).");
  const url = await reauthProvider({ interactive: false, partition });
  return sessionFromUrl(url, region || undefined, 'riot');
}

// ---------- enregistrement d'une session dans la liste des comptes ----------
// Pour les modes local / url (non persistés) : si le puuid existe déjà, on met à jour ce compte.
function registerSession(sess) {
  let acc = byPuuid(sess.puuid);
  if (!acc) {
    acc = { id: newId(), puuid: sess.puuid, name: null, region: sess.region, partition: null, mode: sess.mode, session: null, needsRelogin: false, renewing: null };
    accounts.set(acc.id, acc);
  }
  acc.session = sess;
  acc.region = sess.region;
  acc.needsRelogin = false;
  activeId = acc.id;
  return acc;
}

export async function loginLocal(regionOverride) {
  const acc = registerSession(await sessionFromLocal(regionOverride));
  await refreshName(acc);
  persist();
  return acc.session;
}

export async function loginFromUrl(rawUrl, regionOverride, mode = 'url') {
  const acc = registerSession(await sessionFromUrl(rawUrl, regionOverride, mode));
  await refreshName(acc);
  persist();
  return acc.session;
}

// Ajoute un compte Riot : fenêtre de connexion dans une NOUVELLE partition (cookies vierges).
export async function addAccount({ region } = {}) {
  if (!reauthProvider) throw new Error("La connexion Riot intégrée n'est dispo que dans l'app (npm run app).");
  return exclusive(async () => {
    const id = newId();
    const partition = `persist:riot-${id}`;
    let sess;
    try {
      const url = await reauthProvider({ interactive: true, partition });
      sess = await sessionFromUrl(url, region, 'riot');
    } catch (e) {
      await dropPartition(partition);
      throw e;
    }
    let acc = byPuuid(sess.puuid);
    if (acc) {
      // Compte déjà connu : on met à jour l'entrée au lieu d'en créer une deuxième.
      // Si ses anciens cookies sont inutilisables, on adopte les nouveaux ; sinon on jette la nouvelle partition.
      if (!acc.partition || acc.needsRelogin) {
        const old = acc.partition;
        acc.partition = partition;
        acc.mode = 'riot';
        await dropPartition(old);
      } else {
        await dropPartition(partition);
      }
    } else {
      acc = { id, puuid: sess.puuid, name: null, region: sess.region, partition, mode: 'riot', session: null, needsRelogin: false, renewing: null };
      accounts.set(id, acc);
    }
    acc.session = sess;
    acc.region = sess.region;
    acc.needsRelogin = false;
    activeId = acc.id;
    await refreshName(acc);
    persist();
    return sess;
  });
}
export const loginRiot = addAccount;

// Reconnexion interactive d'un compte donné, dans sa propre partition.
export async function reloginAccount(id) {
  const acc = accounts.get(id);
  if (!acc) throw Object.assign(new Error('Compte introuvable'), { status: 404 });
  if (!acc.partition) throw Object.assign(new Error("Ce compte n'a pas de session Riot intégrée : ajoute-le à nouveau."), { status: 400 });
  return exclusive(async () => {
    const url = await reauthProvider({ interactive: true, partition: acc.partition });
    const sess = await sessionFromUrl(url, acc.region || undefined, 'riot');
    if (acc.puuid && sess.puuid !== acc.puuid) {
      await dropPartition(acc.partition); // la fenêtre a connecté un autre compte Riot
      throw Object.assign(new Error(`Ce n'est pas le même compte Riot${acc.name ? ` (attendu : ${acc.name})` : ''}.`), { status: 400 });
    }
    acc.puuid = sess.puuid;
    acc.session = sess;
    acc.region = sess.region;
    acc.needsRelogin = false;
    activeId = acc.id;
    await refreshName(acc);
    persist();
    return sess;
  });
}

// Change de compte actif ; ré-authentification silencieuse si aucune session vivante.
export async function switchAccount(id) {
  const acc = accounts.get(id);
  if (!acc) throw Object.assign(new Error('Compte introuvable'), { status: 404 });
  activeId = id;
  persist();
  await ensureFresh(acc); // 401 (avec accountId) si ce compte doit se reconnecter
  if (!acc.name) await refreshName(acc);
  return acc.session;
}

// Retire un compte (et ses cookies) ; bascule sur un autre si possible (ré-auth paresseuse au 1er appel).
export async function removeAccount(id) {
  const acc = accounts.get(id);
  if (!acc) return;
  accounts.delete(id);
  await dropPartition(acc.partition);
  if (activeId === id) {
    const rest = [...accounts.values()];
    activeId = (rest.find((a) => a.session && !a.needsRelogin) || rest[0])?.id ?? null;
  }
  persist();
}
export async function logout() { if (activeId) await removeAccount(activeId); }

// Démarrage : charge accounts.json, migre l'ancienne partition `persist:riot` au besoin,
// puis restaure silencieusement le compte actif (les autres le seront à la demande).
export async function initAccounts() {
  let data = null;
  try { data = store?.load() ?? null; } catch (e) { console.warn('[accounts]', e.message); }

  if (data && Array.isArray(data.accounts)) {
    for (const a of data.accounts) {
      if (!a?.id || !a.partition) continue;
      accounts.set(a.id, {
        id: a.id, puuid: a.puuid || null, name: a.name || null, region: a.region || null,
        partition: a.partition, mode: 'riot', session: null, needsRelogin: false, renewing: null,
      });
    }
    activeId = accounts.has(data.active) ? data.active : ([...accounts.keys()][0] ?? null);
    persistedActive = activeId;
    const acc = activeAccount();
    if (acc) {
      try { await ensureFresh(acc); } catch { /* needsRelogin positionné : l'UI proposera la reconnexion */ }
      if (acc.session && !acc.name) await refreshName(acc);
    }
    return;
  }

  // Première exécution : l'ancienne partition unique devient le premier compte (pas de nouvelle connexion).
  // Si elle n'est plus valide, rien n'est écrit : la migration sera retentée au prochain démarrage.
  if (!reauthProvider) return;
  const acc = { id: newId(), puuid: null, name: null, region: null, partition: LEGACY_PARTITION, mode: 'riot', session: null, needsRelogin: false, renewing: null };
  try {
    acc.session = await sessionFromPartition(LEGACY_PARTITION);
    acc.puuid = acc.session.puuid;
    acc.region = acc.session.region;
    accounts.set(acc.id, acc);
    activeId = acc.id;
    await refreshName(acc);
    persist();
  } catch { /* pas de session à migrer */ }
}

// ---------- renouvellement ----------
function renew(acc) {
  if (!acc.renewing) {
    acc.renewing = (async () => {
      let s;
      if (acc.mode === 'local') s = await sessionFromLocal(acc.region || undefined);
      else if (acc.mode === 'riot') s = await sessionFromPartition(acc.partition, acc.region);
      else throw new Error('non renouvelable');
      if (acc.puuid && s.puuid !== acc.puuid) throw new Error('un autre compte est connecté');
      acc.session = s;
      acc.region = s.region;
      acc.needsRelogin = false;
    })().finally(() => { acc.renewing = null; });
  }
  return acc.renewing;
}

// Compte perdu : persisté -> "Reconnexion requise" ; non persisté (local / url) -> retiré de la liste.
function lose(acc, reason) {
  acc.session = null;
  console.warn(`[auth] ${acc.name || acc.id} : ${reason}`);
  if (acc.partition) {
    acc.needsRelogin = true;
    throw authError(reloginMessage(acc), acc.id);
  }
  accounts.delete(acc.id);
  if (activeId === acc.id) {
    const rest = [...accounts.values()];
    activeId = (rest.find((a) => a.session) || rest[0])?.id ?? null;
  }
  persist();
  throw authError('Session expirée, reconnecte-toi.');
}

async function recover(acc) {
  try { await renew(acc); } catch (e) { lose(acc, e.message); }
}

async function ensureFresh(acc) {
  if (!acc) throw authError('Non connecté');
  if (acc.needsRelogin && !acc.session) throw authError(reloginMessage(acc), acc.id);
  if (acc.session && Date.now() < acc.session.expiresAt - 60_000) return;
  await recover(acc);
}

// ---------- assets publics (valorant-api.com) ----------
let clientVersion = null;
async function getClientVersion() {
  if (clientVersion) return clientVersion;
  const r = await fetch('https://valorant-api.com/v1/version');
  clientVersion = (await r.json()).data.riotClientVersion;
  return clientVersion;
}

let assetsCache = null;
export async function getAssets() {
  if (assetsCache) return assetsCache;
  const [weapons, tiers] = await Promise.all([
    fetch('https://valorant-api.com/v1/weapons?language=fr-FR').then((r) => r.json()),
    fetch('https://valorant-api.com/v1/contenttiers?language=fr-FR').then((r) => r.json()),
  ]);
  const tierById = Object.fromEntries(tiers.data.map((t) => [t.uuid, {
    name: t.devName, rank: t.rank, color: '#' + (t.highlightColor || 'ffffffff').slice(0, 6), icon: t.displayIcon,
  }]));
  const levelToSkin = new Map();
  for (const w of weapons.data) {
    for (const s of w.skins) {
      for (const l of s.levels) levelToSkin.set(l.uuid, { weapon: w, skin: s });
    }
  }
  assetsCache = { weapons: weapons.data, tierById, levelToSkin };
  return assetsCache;
}

// ---------- appels authentifiés vers les serveurs Valorant ----------
// Toujours liés à un compte précis (capturé au début de l'appel) : un changement de compte
// en cours de route ne mélange pas les sessions.
function baseUrl(host, s) {
  if (host === 'glz') return `https://glz-${s.region}-1.${s.shard}.a.pvp.net`;
  if (host === 'shared') return `https://shared.${s.shard}.a.pvp.net`;
  return `https://pd.${s.shard}.a.pvp.net`;
}

async function pdFor(acc, pathname, { method = 'GET', body, host = 'pd' } = {}, retried = false) {
  await ensureFresh(acc);
  const s = acc.session;
  const res = await fetch(`${baseUrl(host, s)}${pathname.replace('{puuid}', s.puuid)}`, {
    method,
    headers: {
      Authorization: `Bearer ${s.accessToken}`,
      'X-Riot-Entitlements-JWT': s.entToken,
      'X-Riot-ClientPlatform': CLIENT_PLATFORM,
      'X-Riot-ClientVersion': await getClientVersion(),
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.ok) return res.json();
  const text = await res.text().catch(() => '');
  // 401, ou 400 "BAD_CLAIMS" = token expiré ; un autre 400 est une vraie erreur (ex. corps invalide)
  const authFailed = res.status === 401 || (res.status === 400 && /BAD_CLAIMS|token/i.test(text));
  if (authFailed) {
    if (!retried && (acc.mode === 'local' || acc.mode === 'riot')) {
      await recover(acc);
      return pdFor(acc, pathname, { method, body, host }, true);
    }
    lose(acc, `Riot a refusé la requête (${res.status})`);
  }
  throw Object.assign(new Error(`Erreur Riot ${res.status} sur ${pathname} ${text.slice(0, 200)}`), { riotStatus: res.status });
}
const pd = (pathname, opts) => pdFor(mustBeActive(), pathname, opts);

// Récupère "Nom#TAG" du compte et le mémorise (best effort)
async function refreshName(acc) {
  try {
    const r = await pdFor(acc, '/name-service/v2/players', { method: 'PUT', body: [acc.puuid] });
    if (r?.[0]) { acc.name = `${r[0].GameName}#${r[0].TagLine}`; persist(); }
  } catch { /* pas bloquant */ }
}
export async function refreshActiveName() {
  const acc = activeAccount();
  if (acc?.session && !acc.name) await refreshName(acc);
}

// Riot change parfois la version de l'endpoint loadout : on essaie plusieurs variantes.
let loadoutPath = null;
async function getLoadout(acc = mustBeActive()) {
  const candidates = loadoutPath ? [loadoutPath] : [
    '/personalization/v3/players/{puuid}/playerloadout',
    '/personalization/v2/players/{puuid}/playerloadout',
  ];
  let lastErr;
  for (const p of candidates) {
    try {
      const r = await pdFor(acc, p);
      loadoutPath = p;
      return r;
    } catch (e) {
      lastErr = e;
      console.warn('[loadout]', e.message);
      if (e.riotStatus !== 404) break;
    }
  }
  throw lastErr;
}

// Modifie le skin équipé d'une arme : on renvoie le loadout complet (sprays, carte, titre…)
// en ne changeant que l'arme concernée.
async function equipSkin({ weaponId, skinId, levelId, chromaId }) {
  const acc = mustBeActive();
  const current = await getLoadout(acc);
  const gun = (current.Guns || []).find((g) => g.ID.toLowerCase() === weaponId.toLowerCase());
  if (!gun) throw new Error('Arme absente du loadout');
  gun.SkinID = skinId;
  gun.SkinLevelID = levelId;
  gun.ChromaID = chromaId;
  const body = { Guns: current.Guns, Sprays: current.Sprays, Identity: current.Identity, Incognito: current.Incognito };
  return pdFor(acc, loadoutPath, { method: 'PUT', body });
}

// ---------- partie en cours ----------
// Le compte réellement en jeu est celui du Riot Client de ce PC : on l'utilise s'il tourne,
// sinon on se rabat sur le compte actif de l'appli.
let liveLocal = null;
async function liveAccount() {
  try {
    if (!liveLocal || !liveLocal.session || Date.now() > liveLocal.session.expiresAt - 60_000) {
      const s = await sessionFromLocal(activeAccount()?.session?.region);
      liveLocal = { id: 'live-local', mode: 'local', puuid: s.puuid, region: s.region, session: s };
    }
    return liveLocal;
  } catch {
    liveLocal = null;
    return mustBeActive();
  }
}

export async function liveContext() {
  const acc = await liveAccount();
  return {
    puuid: acc.session?.puuid || acc.puuid,
    source: acc.id === 'live-local' ? 'client' : 'app',
    call: async (pathname, opts) => {
      try { return await pdFor(acc, pathname, opts); } catch (e) {
        // erreur d'auth du Riot Client local : on ne déconnecte pas l'appli pour autant
        if (acc.id === 'live-local' && e.status === 401) liveLocal = null;
        throw e;
      }
    },
  };
}

// Contexte du compte sélectionné dans l'appli (stats "Mes stats", détails de partie)
export async function activeContext() {
  const acc = mustBeActive();
  await ensureFresh(acc);
  return { puuid: acc.session.puuid, source: 'app', call: (pathname, opts) => pdFor(acc, pathname, opts) };
}
export function activePuuid() {
  const acc = activeAccount();
  return acc?.session?.puuid || acc?.puuid || null;
}

// Présences du chat local (score, groupe) — seulement si le Riot Client tourne
export async function localPresences() {
  try { return (await localRequest('/chat/v4/presences')).presences || []; } catch { return null; }
}

export const api = {
  equip: equipSkin,
  storefront: () => pd('/store/v3/storefront/{puuid}', { method: 'POST', body: {} }),
  wallet: () => pd('/store/v1/wallet/{puuid}'),
  owned: (typeId) => pd(`/store/v1/entitlements/{puuid}/${typeId}`),
  loadout: () => getLoadout(),
  name: async () => {
    const acc = mustBeActive();
    await refreshName(acc);
    return acc.name;
  },
};
