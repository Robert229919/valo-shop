import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  api, getAssets, getSession, loginLocal, loginFromUrl, loginRiot, logout, hasReauthProvider,
  listAccounts, getActiveId, addAccount, switchAccount, reloginAccount, removeAccount, refreshActiveName,
  ITEM_TYPES, CURRENCIES, LOGIN_URL,
} from './riot.js';
import { buildLive } from './live.js';
import { myStats, playerStats, matchDetail } from './stats.js';
import { partyState, setQueue, startQueue, stopQueue, launchGame } from './party.js';

const PORT = Number(process.env.PORT) || 5173;
const HOST = '127.0.0.1'; // accessible uniquement depuis ce PC
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

// ---------- mise en forme des données ----------
const isRandomSkin = (s) => /random/i.test(s.assetPath || '') || /al[ée]atoire|random/i.test(s.displayName);

function skinImage(skin, chromaId) {
  const chroma = skin.chromas.find((c) => c.uuid === chromaId);
  return chroma?.fullRender || skin.displayIcon || skin.levels[0]?.displayIcon
    || skin.chromas[0]?.fullRender || skin.chromas[0]?.displayIcon || null;
}

function shapeSkin(skin, tierById, extra = {}) {
  const tier = tierById[skin.contentTierUuid] || null;
  return {
    uuid: skin.uuid,
    name: skin.displayName,
    image: skinImage(skin, extra.chromaId),
    tier,
    levelCount: skin.levels.length,
    chromaCount: skin.chromas.length,
    ...extra,
  };
}

// Cosmétiques hors skins (pour le contenu des packs), chargés une fois
let cosmeticsCache = null;
async function getCosmetics() {
  if (cosmeticsCache) return cosmeticsCache;
  const j = (u) => fetch(`https://valorant-api.com/v1/${u}?language=fr-FR`).then((r) => r.json()).then((r) => r.data || []).catch(() => []);
  const [buddies, sprays, cards, titles, flex] = await Promise.all([j('buddies'), j('sprays'), j('playercards'), j('playertitles'), j('flex')]);
  const m = new Map();
  for (const b of buddies) for (const l of b.levels || []) m.set(l.uuid, { kind: 'buddy', label: 'Porte-bonheur', name: b.displayName, image: l.displayIcon || b.displayIcon });
  for (const s of sprays) m.set(s.uuid, { kind: 'spray', label: 'Tag', name: s.displayName, image: s.fullTransparentIcon || s.displayIcon });
  for (const c of cards) m.set(c.uuid, { kind: 'card', label: 'Carte de joueur', name: c.displayName, image: c.largeArt || c.wideArt || c.displayIcon });
  for (const t of titles) m.set(t.uuid, { kind: 'title', label: 'Titre', name: t.titleText || t.displayName, image: null });
  for (const f of flex) m.set(f.uuid, { kind: 'flex', label: 'Accessoire', name: f.displayName, image: f.displayIcon });
  cosmeticsCache = m;
  return m;
}

let bundleCache = new Map();
async function bundleInfo(id) {
  if (!bundleCache.has(id)) {
    const r = await fetch(`https://valorant-api.com/v1/bundles/${id}?language=fr-FR`).then((x) => x.json()).catch(() => null);
    bundleCache.set(id, r?.data || null);
  }
  return bundleCache.get(id);
}

async function buildShop() {
  const [store, wallet, owned, { levelToSkin, tierById }] = await Promise.all([
    api.storefront(), api.wallet(), api.owned(ITEM_TYPES.skinLevel), getAssets(),
  ]);
  const ownedLevels = new Set((owned.Entitlements || []).map((e) => e.ItemID));

  const toSkin = (levelId, price, more = {}) => {
    const hit = levelToSkin.get(levelId);
    if (!hit) return { uuid: levelId, name: 'Objet inconnu', price, ...more };
    return shapeSkin(hit.skin, tierById, {
      weapon: hit.weapon.displayName,
      price,
      owned: ownedLevels.has(levelId),
      ...more,
    });
  };

  const panel = store.SkinsPanelLayout || {};
  const daily = (panel.SingleItemStoreOffers || []).map((o) =>
    toSkin(o.Rewards?.[0]?.ItemID, o.Cost?.[CURRENCIES.vp]));

  let nightMarket = null;
  if (store.BonusStore?.BonusStoreOffers?.length) {
    nightMarket = {
      remaining: store.BonusStore.BonusStoreRemainingDurationInSeconds,
      offers: store.BonusStore.BonusStoreOffers.map((b) => toSkin(
        b.Offer?.Rewards?.[0]?.ItemID,
        b.DiscountCosts?.[CURRENCIES.vp],
        { basePrice: b.Offer?.Cost?.[CURRENCIES.vp], discount: b.DiscountPercent, seen: b.IsSeen },
      )),
    };
  }

  const bundles = await Promise.all((store.FeaturedBundle?.Bundles || []).map(async (b) => {
    const info = await bundleInfo(b.DataAssetID);
    const price = b.TotalDiscountedCost?.[CURRENCIES.vp]
      ?? (b.Items || []).reduce((sum, it) => sum + (it.DiscountedPrice || 0), 0);
    const cos = await getCosmetics();
    // contenu du pack : skins, porte-bonheur, tags, cartes, titres…
    const items = (b.Items || []).map((it) => {
      const type = String(it.Item?.ItemTypeID || '').toLowerCase();
      const id = String(it.Item?.ItemID || '').toLowerCase();
      const prices = { price: it.DiscountedPrice ?? it.BasePrice ?? null, basePrice: it.BasePrice ?? null, amount: it.Item?.Amount || 1 };
      if (type === ITEM_TYPES.skinLevel) {
        const hit = levelToSkin.get(id) || levelToSkin.get(it.Item.ItemID);
        if (hit) {
          return shapeSkin(hit.skin, tierById, {
            kind: 'skin', kindLabel: 'Skin', weapon: hit.weapon.displayName, owned: ownedLevels.has(it.Item.ItemID), ...prices,
          });
        }
      }
      const c = cos.get(id);
      return {
        kind: c?.kind || 'other', kindLabel: c?.label || 'Objet', name: c?.name || 'Objet inconnu',
        image: c?.image || null, ...prices,
      };
    });
    return {
      name: info?.displayName || 'Bundle',
      image: info?.displayIcon2 || info?.displayIcon || null,
      price,
      basePrice: (b.Items || []).reduce((sum, it) => sum + (it.BasePrice || 0), 0) || null,
      remaining: b.DurationRemainingInSeconds,
      items,
    };
  }));

  return {
    daily,
    dailyRemaining: panel.SingleItemOffersRemainingDurationInSeconds,
    nightMarket,
    bundles,
    wallet: {
      vp: wallet.Balances?.[CURRENCIES.vp] ?? 0,
      radianite: wallet.Balances?.[CURRENCIES.radianite] ?? 0,
      kingdom: wallet.Balances?.[CURRENCIES.kingdom] ?? 0,
    },
  };
}

const CATEGORY_ORDER = ['Sidearm', 'SMG', 'Shotgun', 'Rifle', 'Sniper', 'Heavy', 'Melee'];
const CATEGORY_FR = {
  Sidearm: 'Armes de poing', SMG: 'Mitraillettes', Shotgun: 'Fusils à pompe', Rifle: 'Fusils',
  Sniper: 'Fusils de précision', Heavy: 'Armes lourdes', Melee: 'Corps à corps',
};

async function buildCollection() {
  let loadoutError = null;
  const [owned, ownedChromaRes, loadout, { weapons, tierById }] = await Promise.all([
    api.owned(ITEM_TYPES.skinLevel),
    api.owned(ITEM_TYPES.skinChroma).catch(() => ({ Entitlements: [] })),
    // le loadout (skins équipés) est un bonus : si Riot le refuse, on affiche quand même la collection
    api.loadout().catch((e) => { loadoutError = e.message; return { Guns: [] }; }),
    getAssets(),
  ]);
  const ownedLevels = new Set((owned.Entitlements || []).map((e) => e.ItemID));
  const ownedChromas = new Set((ownedChromaRes.Entitlements || []).map((e) => e.ItemID));
  const equippedByWeapon = Object.fromEntries((loadout.Guns || []).map((g) => [g.ID.toLowerCase(), g]));

  const out = weapons.map((w) => {
    const eq = equippedByWeapon[w.uuid.toLowerCase()];
    const skins = w.skins
      .filter((s) => !isRandomSkin(s))
      .map((s) => {
        const isDefault = s.uuid === w.defaultSkinUuid;
        const own = isDefault || s.levels.some((l) => ownedLevels.has(l.uuid));
        const equipped = eq?.SkinID === s.uuid;
        const shaped = shapeSkin(s, tierById, {
          owned: own,
          isDefault,
          equipped,
          chromaId: equipped ? eq.ChromaID : undefined,
          levelId: equipped ? eq.SkinLevelID : undefined,
          levelsOwned: own ? (isDefault ? s.levels.length : s.levels.filter((l) => ownedLevels.has(l.uuid)).length) : 0,
          variants: s.chromas.map((c, i) => ({
            uuid: c.uuid,
            name: i === 0 ? 'Base' : (c.displayName.match(/variante\s*\d+\s*([^)]+)\)/i)?.[1]?.trim() || c.displayName.replace(/\s+/g, ' ')),
            swatch: c.swatch,
            image: c.fullRender || c.displayIcon,
            owned: own && (i === 0 || ownedChromas.has(c.uuid)),
          })),
        });
        // le skin Standard n'a pas de vrai rendu (icône ✕) : on prend l'icône de l'arme
        if (isDefault) {
          shaped.image = w.displayIcon;
          shaped.variants.forEach((v) => { v.image = w.displayIcon; });
        }
        return shaped;
      })
      .sort((a, b) => (b.equipped - a.equipped) || (b.owned - a.owned)
        || ((b.tier?.rank ?? -1) - (a.tier?.rank ?? -1)) || a.name.localeCompare(b.name, 'fr'));
    const category = (w.category || '').split('::').pop();
    const equippedSkin = skins.find((s) => s.equipped) || skins.find((s) => s.isDefault);
    return {
      uuid: w.uuid,
      name: w.displayName,
      icon: w.displayIcon,
      category,
      categoryLabel: CATEGORY_FR[category] || category,
      equipped: equippedSkin,
      ownedCount: skins.filter((s) => s.owned && !s.isDefault).length,
      total: skins.filter((s) => !s.isDefault).length,
      skins,
    };
  });
  out.sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category)
    || a.name.localeCompare(b.name, 'fr'));
  return { weapons: out, loadoutError };
}

async function equip({ weaponId, skinId, chromaId }) {
  const [{ weapons }, owned, ownedChromaRes] = await Promise.all([
    getAssets(), api.owned(ITEM_TYPES.skinLevel), api.owned(ITEM_TYPES.skinChroma).catch(() => ({ Entitlements: [] })),
  ]);
  const weapon = weapons.find((w) => w.uuid.toLowerCase() === String(weaponId).toLowerCase());
  const skin = weapon?.skins.find((s) => s.uuid === skinId);
  if (!skin) throw Object.assign(new Error('Skin introuvable'), { status: 400 });

  const ownedLevels = new Set((owned.Entitlements || []).map((e) => e.ItemID));
  const ownedChromas = new Set((ownedChromaRes.Entitlements || []).map((e) => e.ItemID));
  const isDefault = skin.uuid === weapon.defaultSkinUuid;
  const levels = isDefault ? skin.levels : skin.levels.filter((l) => ownedLevels.has(l.uuid));
  if (!levels.length) throw Object.assign(new Error("Tu ne possèdes pas ce skin"), { status: 400 });

  // on équipe le niveau le plus haut possédé (effets/animations complets)
  const level = levels[levels.length - 1];
  const chromaIdx = skin.chromas.findIndex((c) => c.uuid === chromaId);
  const chroma = chromaIdx > 0 && ownedChromas.has(chromaId) ? skin.chromas[chromaIdx] : skin.chromas[0];

  await api.equip({ weaponId: weapon.uuid, skinId: skin.uuid, levelId: level.uuid, chromaId: chroma.uuid });
  return { ok: true, weapon: weapon.displayName, skin: skin.displayName, variant: chroma.displayName };
}

// ---------- serveur HTTP ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  try { return body ? JSON.parse(body) : {}; } catch { return {}; }
}

function publicSession(s) {
  return s ? { connected: true, mode: s.mode, region: s.region, shard: s.shard } : { connected: false };
}

// Liste des comptes (jamais de token) ; complète le Riot ID du compte actif s'il manque
async function accountsState() {
  await refreshActiveName().catch(() => {});
  return { accounts: listAccounts(), activeId: getActiveId() };
}

const needId = (body) => {
  if (!body.id) throw Object.assign(new Error('Compte manquant'), { status: 400 });
  return String(body.id);
};

// Erreurs Riot des onglets En jeu / stats : jamais de 401 (sinon l'appli croirait le compte déconnecté)
async function soft(fn) {
  try { return await fn(); } catch (e) {
    throw Object.assign(new Error(e.message), { status: e.status && e.status !== 401 ? e.status : 503 });
  }
}
const clampN = (v, d) => Math.min(20, Math.max(1, Number(v) || d));

const routes = {
  'GET /api/status': async () => {
    const state = await accountsState();
    const name = state.accounts.find((a) => a.active)?.name ?? null;
    return {
      ...publicSession(getSession()), name, loginUrl: LOGIN_URL, riotLoginAvailable: hasReauthProvider(), ...state,
    };
  },
  'GET /api/accounts': accountsState,
  'POST /api/accounts/add': async (body) => { await addAccount({ region: body.region || undefined }); return accountsState(); },
  'POST /api/accounts/switch': async (body) => { await switchAccount(needId(body)); return accountsState(); },
  'POST /api/accounts/relogin': async (body) => { await reloginAccount(needId(body)); return accountsState(); },
  'POST /api/accounts/remove': async (body) => { await removeAccount(needId(body)); return accountsState(); },
  'POST /api/login/riot': async (body) => publicSession(await loginRiot({ region: body.region || undefined })),
  'POST /api/login/local': async (body) => publicSession(await loginLocal(body.region || undefined)),
  'POST /api/login/url': async (body) => publicSession(await loginFromUrl(body.url, body.region || undefined)),
  // ne déconnecte que le compte actif ; bascule sur un autre s'il en reste
  'POST /api/logout': async () => { await logout(); return accountsState(); },
  'GET /api/shop': buildShop,
  'GET /api/collection': buildCollection,
  'POST /api/equip': equip,
  // partie en cours : les erreurs restent dans l'onglet (pas de déconnexion de l'appli)
  // statistiques des parties (erreurs gardées dans l'onglet)
  'GET /api/stats/me': (q) => soft(() => myStats({ queue: q.queue || 'competitive', n: clampN(q.n, 20) })),
  'GET /api/stats/player': (q) => {
    if (!/^[0-9a-f-]{36}$/i.test(q.puuid || '')) throw Object.assign(new Error('puuid invalide'), { status: 400 });
    return soft(() => playerStats({ puuid: q.puuid, n: clampN(q.n, 5), queue: q.queue || 'competitive' }));
  },
  'GET /api/stats/match': (q) => soft(() => matchDetail({ id: q.id, puuid: q.puuid })),
  // groupe, choix du mode, recherche de partie, lancement du jeu
  'GET /api/party': () => soft(partyState),
  'POST /api/party/queue': (b) => soft(() => setQueue(String(b.queueId || ''))),
  'POST /api/party/start': () => soft(startQueue),
  'POST /api/party/stop': () => soft(stopQueue),
  'POST /api/game/launch': () => soft(launchGame),
  'GET /api/live': async () => {
    try { return await buildLive(); } catch (e) { throw Object.assign(new Error(e.message), { status: 503 }); }
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Protection basique : on refuse les requêtes venant d'un autre site (CSRF / DNS rebinding)
  const host = (req.headers.host || '').split(':')[0];
  if (!['127.0.0.1', 'localhost'].includes(host)) { res.writeHead(403); return res.end(); }

  const route = routes[`${req.method} ${url.pathname}`];
  if (route) {
    const origin = req.headers.origin;
    if (req.method !== 'GET' && origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
      return send(res, 403, { error: 'Origine refusée' });
    }
    try {
      // GET : paramètres de l'URL ; POST : corps JSON
      const body = req.method === 'POST' ? await readBody(req) : Object.fromEntries(url.searchParams);
      return send(res, 200, await route(body));
    } catch (e) {
      console.error(`[${url.pathname}]`, e.message);
      return send(res, e.status || 500, { error: e.message, ...(e.accountId ? { accountId: e.accountId } : {}) });
    }
  }

  // fichiers statiques
  const file = path.normalize(path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': (MIME[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8' });
  fs.createReadStream(file).pipe(res);
});

export const ready = new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(PORT, HOST, () => {
    console.log(`Valo Shop Viewer -> http://localhost:${PORT}`);
    getAssets().catch((e) => console.warn('Préchargement des assets impossible :', e.message));
    resolve(`http://localhost:${PORT}`);
  });
});
