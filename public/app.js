const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ICON = (id) => `https://media.valorant-api.com/currencies/${id}/displayicon.png`;
const TIER_FR = { Select: 'Select', Deluxe: 'Deluxe', Premium: 'Premium', Exclusive: 'Exclusive', Ultra: 'Ultra' };

async function call(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    // un compte précis doit se reconnecter (on garde les autres), ou plus aucun compte : écran de connexion
    await refreshAccounts().catch(() => {});
    if (!accounts.length) showLogin(data.error);
    else if (data.accountId) showRelogin(data.error);
    else { toast(data.error, true); setTimeout(onAccountChanged, 0); } // compte non persisté expiré : un autre devient actif
    throw Object.assign(new Error(data.error), { handled: true });
  }
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}

function loading(on) { $('#loading').classList.toggle('hidden', !on); }
function setError(msg) { $('#global-error').textContent = msg || ''; }

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

// "Vandal (Primordium)" -> { title: "Primordium", weapon: "Vandal" }
function splitName(name, weapon) {
  const m = String(name).match(/^(.*?)\s*\((.+)\)\s*$/);
  if (m) return { title: m[2], weapon: weapon || m[1] };
  if (weapon && name.endsWith(` ${weapon}`)) return { title: name.slice(0, -weapon.length - 1), weapon };
  return { title: name, weapon: weapon || '' };
}

// ---------- thème ----------
$('#theme').onclick = () => {
  const root = document.documentElement;
  const dark = root.dataset.theme
    ? root.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('theme', root.dataset.theme); } catch { /* stockage indisponible */ }
};
$('#date').textContent = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  .replace(/^./, (c) => c.toUpperCase());

// ---------- timers ----------
const timers = [];
function startTimer(el, seconds) { timers.push({ el, end: Date.now() + seconds * 1000 }); }
function fmt(ms) {
  if (ms <= 0) return '00:00:00';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return (d ? `${d}j ` : '') + `${pad(h)}:${pad(m)}:${pad(sec)}`;
}
setInterval(() => timers.forEach((t) => (t.el.textContent = fmt(t.end - Date.now()))), 1000);

// ---------- cadres ----------
function frame(s, { weapon, price, basePrice, discount, owned, equipped, notOwned, controls = '', id } = {}) {
  const { title, weapon: w } = splitName(s.name, weapon || s.weapon);
  const tierName = s.tier ? TIER_FR[s.tier.name] || s.tier.name : 'Standard';
  const classes = ['frame', equipped && 'equipped', s.isDefault && 'is-default'].filter(Boolean).join(' ');
  let tag = '';
  if (equipped) tag = '<span class="tag glow">Équipé</span>';
  else if (owned) tag = '<span class="tag">Possédé</span>';
  else if (notOwned) tag = '<span class="tag outline">Non possédé</span>';
  const disc = discount ? `<span class="tag right">−${discount}%</span>` : '';
  const foot = price != null
    ? `<span class="price">${price.toLocaleString('fr-FR')}${basePrice ? ` <s>${basePrice.toLocaleString('fr-FR')}</s>` : ''} <small>VP</small></span>`
    : '';
  return `
    <article class="${classes}" style="--tier:${s.tier?.color || 'var(--ink-soft)'}" ${id ? `data-skin="${id}"` : ''}>
      ${tag}${disc}
      <div class="mat">${s.image ? `<img src="${esc(s.image)}" alt="" loading="lazy">` : ''}</div>
      <div class="caption">
        <div class="meta-line"><i class="tier-dot"></i>${esc(tierName)}${w ? ` · ${esc(w)}` : ''}</div>
        <h3>${esc(title)}</h3>
        ${controls || (foot ? `<div class="foot">${foot}</div>` : '')}
      </div>
    </article>`;
}

function renderWallet(w) {
  $('#wallet').innerHTML = `
    <span title="Valorant Points"><img src="${ICON('85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741')}" alt="">${w.vp.toLocaleString('fr-FR')}</span>
    <span title="Radianite"><img src="${ICON('e59aa87c-4cbf-517a-5983-6e81511be9b7')}" alt="">${w.radianite.toLocaleString('fr-FR')}</span>
    <span title="Kingdom Credits"><img src="${ICON('85ca954a-41f2-ce94-9b45-8ca3dd39a00d')}" alt="">${w.kingdom.toLocaleString('fr-FR')}</span>`;
}

// ---------- boutique ----------
async function loadShop() {
  loading(true); setError('');
  timers.length = 0;
  const my = epoch;
  try {
    const shop = await call('/api/shop');
    if (my !== epoch) return; // le compte a changé pendant le chargement
    renderWallet(shop.wallet);
    $('#daily').innerHTML = shop.daily.map((s) => frame(s, { price: s.price, owned: s.owned })).join('');
    startTimer($('#daily-timer'), shop.dailyRemaining);

    $('#night-wrap').classList.toggle('hidden', !shop.nightMarket);
    if (shop.nightMarket) {
      $('#night').innerHTML = shop.nightMarket.offers.map((s) => frame(s, {
        price: s.price, basePrice: s.basePrice, discount: s.discount, owned: s.owned,
      })).join('');
      startTimer($('#night-timer'), shop.nightMarket.remaining);
    }

    $('#bundles-wrap').classList.toggle('hidden', !shop.bundles.length);
    shopBundles = shop.bundles;
    $('#bundles').innerHTML = shop.bundles.map((b, i) => `
      <article class="bundle" data-bundle="${i}" tabindex="0" role="button" title="Voir le contenu du pack">
        ${b.image ? `<img src="${esc(b.image)}" alt="">` : ''}
        <div class="headline">
          <h3>${esc(b.name)}</h3>
          <span class="bundle-count">${(b.items || []).length} objets · voir le contenu</span>
          <span class="price">${b.price.toLocaleString('fr-FR')} <small>VP</small></span>
        </div>
      </article>`).join('');
    timers.forEach((t) => (t.el.textContent = fmt(t.end - Date.now())));
  } catch (e) {
    if (my !== epoch) return;
    if (!e.handled) setError(e.message);
  }
  loading(false);
}

// ---------- collection ----------
let collection = null;
async function loadCollection(force = false) {
  if (collection && !force) return renderCollection();
  loading(true); setError('');
  const my = epoch;
  try {
    const data = await call('/api/collection');
    if (my !== epoch) return; // le compte a changé pendant le chargement
    collection = data.weapons;
    $('#loadout-warn').classList.toggle('hidden', !data.loadoutError);
    $('#loadout-warn').textContent = data.loadoutError
      ? `Impossible de récupérer les skins équipés (${data.loadoutError}). Les skins possédés sont quand même affichés.`
      : '';
    renderCollection();
  } catch (e) {
    if (my !== epoch) return;
    if (!e.handled) setError(e.message);
  }
  loading(false);
}

function renderCollection() {
  const q = $('#search').value.trim().toLowerCase();
  const ownedOnly = $('#owned-only').checked;
  const owned = collection.reduce((n, w) => n + w.ownedCount, 0);
  const total = collection.reduce((n, w) => n + w.total, 0);
  $('#collection-stats').textContent = `${owned} skins possédés sur ${total.toLocaleString('fr-FR')}`;

  $('#board').classList.toggle('hidden', !!q);
  $('#search-results').classList.toggle('hidden', !q);
  if (q) {
    const hits = collection.flatMap((w) => w.skins
      .filter((s) => s.name.toLowerCase().includes(q) && (!ownedOnly || s.owned))
      .map((s) => ({ s, w })));
    $('#search-results').innerHTML = hits.length
      ? `<div class="wall skin-wall">${hits.map(({ s, w }) => frame(s, {
        weapon: w.name, owned: s.owned && !s.isDefault, equipped: s.equipped, notOwned: !s.owned,
      })).join('')}</div>`
      : '<p class="empty">Aucun skin ne correspond.</p>';
    return;
  }
  renderBoard();
}

// Disposition du menu d'achat Valorant : 4 colonnes, dans cet ordre.
const BOARD = [
  [{ cat: 'Sidearm', label: 'Armes de poing', order: ['Classic', 'Shorty', 'Frenzy', 'Ghost', 'Bandit', 'Sheriff'] }],
  [
    { cat: 'SMG', label: 'Mitraillettes', order: ['Stinger', 'Spectre'] },
    { cat: 'Shotgun', label: 'Fusils à pompe', order: ['Bucky', 'Judge'] },
    { cat: 'Melee', label: 'Corps à corps', order: [] },
  ],
  [{ cat: 'Rifle', label: 'Fusils', order: ['Bulldog', 'Guardian', 'Warden', 'Phantom', 'Vandal'] }],
  [
    { cat: 'Sniper', label: 'Fusils de précision', order: ['Marshal', 'Outlaw', 'Operator'] },
    { cat: 'Heavy', label: 'Mitrailleuses', order: ['Ares', 'Odin'] },
  ],
];

function renderBoard() {
  const rank = (g, w) => { const i = g.order.indexOf(w.name); return i < 0 ? 99 : i; };
  $('#board').innerHTML = BOARD.map((col) => `
    <div class="board-col">
      ${col.map((g) => {
        const weapons = collection.filter((w) => w.category === g.cat).sort((a, b) => rank(g, a) - rank(g, b));
        if (!weapons.length) return '';
        const owned = weapons.reduce((n, w) => n + w.ownedCount, 0);
        return `
          <section class="board-group" style="flex:${weapons.length} 1 0">
            <h2>${esc(g.label)}<span>${owned} skins</span></h2>
            <div class="board-items">
              ${weapons.map((w) => `
                <button class="slot ${w.equipped?.isDefault ? 'is-default' : ''}" data-weapon="${w.uuid}" style="--tier:${w.equipped?.tier?.color || 'var(--line)'}" aria-label="${esc(w.name)}">
                  <img src="${esc(w.equipped?.image || w.icon)}" alt="" loading="lazy">
                  <span class="slot-count">${w.ownedCount} / ${w.total}</span>
                  <span class="slot-text">
                    <span class="slot-name">${esc(w.name)}</span>
                    <span class="slot-skin"><i></i>${esc(splitName(w.equipped?.name || '', w.name).title)}</span>
                  </span>
                </button>`).join('')}
            </div>
          </section>`;
      }).join('')}
    </div>`).join('');
  fitBoard();
}

// Le tableau prend toute la hauteur restante de la fenêtre : tout est visible sans scroll.
function fitBoard() {
  const board = $('#board');
  if (!board || board.classList.contains('hidden') || !board.offsetParent) return;
  const top = board.getBoundingClientRect().top + window.scrollY;
  let h = window.innerHeight - top - 28;
  board.style.setProperty('--board-h', `${Math.max(420, h)}px`);
  // on retire ce qui dépasse encore (marges de bas de page, etc.)
  const overflow = document.documentElement.scrollHeight - window.innerHeight;
  if (overflow > 0) {
    h -= overflow;
    board.style.setProperty('--board-h', `${Math.max(420, h)}px`);
  }
}
window.addEventListener('resize', fitBoard);

// Halo orange qui suit la souris
(() => {
  const halo = document.createElement('div');
  halo.id = 'cursor-halo';
  document.body.appendChild(halo);
  let x = 0, y = 0, raf = 0;
  addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    x = e.clientX; y = e.clientY;
    halo.classList.add('on');
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; halo.style.transform = `translate(${x}px, ${y}px)`; });
  }, { passive: true });
  document.documentElement.addEventListener('mouseleave', () => halo.classList.remove('on'));
})();

// ---------- détail d'une arme + équipement ----------
let openWeaponId = null;
const pickedChroma = new Map(); // skinUuid -> chromaUuid sélectionnée

// Toutes les variantes sont prévisualisables (même non possédées) ; seules celles possédées s'équipent.
function equipControls(s) {
  const current = pickedChroma.get(s.uuid) ?? s.chromaId ?? s.variants[0]?.uuid;
  const cur = s.variants.find((v) => v.uuid === current);
  const swatches = s.variants.length > 1
    ? `<div class="swatches">${s.variants.map((v) => `
        <button class="swatch ${v.uuid === current ? 'active' : ''} ${v.owned ? '' : 'unowned'}" data-chroma="${v.uuid}" data-for="${s.uuid}"
          title="${esc(v.name)}${v.owned ? '' : ' (non possédée)'}"
          style="background-image:url('${esc(v.swatch || v.image || '')}')"></button>`).join('')}</div>`
    : '<span></span>';
  let action;
  if (!s.owned) action = '<span class="note">Non possédé</span>';
  else if (cur && !cur.owned) action = '<span class="note">Variante non possédée</span>';
  else if (s.equipped && current === s.chromaId) action = '<span class="equipped-label">Équipé</span>';
  else action = `<button class="btn equip" data-equip="${s.uuid}">${s.equipped ? 'Appliquer' : 'Équiper'}</button>`;
  const lvl = s.owned && s.levelCount > 1
    ? `<div class="sub">Niveau ${s.levelsOwned} / ${s.levelCount}${cur && s.variants.length > 1 ? ` · ${esc(cur.name)}` : ''}</div>`
    : (cur && s.variants.length > 1 ? `<div class="sub">${esc(cur.name)}</div>` : '');
  return `${lvl}<div class="foot">${swatches}${action}</div>`;
}

function skinFrame(w, s) {
  const chroma = pickedChroma.get(s.uuid);
  const img = (chroma && s.variants.find((v) => v.uuid === chroma)?.image) || s.image;
  return frame({ ...s, image: img }, {
    weapon: w.name, owned: s.owned && !s.isDefault && !s.equipped, equipped: s.equipped,
    notOwned: !s.owned, controls: equipControls(s), id: s.uuid,
  });
}

function openWeapon(uuid, { keepOpen = false } = {}) {
  const w = collection.find((x) => x.uuid === uuid);
  if (!w) return;
  openWeaponId = uuid;
  if (!keepOpen) pickedChroma.clear();
  const ownedOnly = $('#owned-only').checked;
  const skins = w.skins.filter((s) => !ownedOnly || s.owned);
  $('#dlg-title').textContent = w.name;
  $('#dlg-sub').textContent = `${w.ownedCount} possédés sur ${w.total} · équipé : ${splitName(w.equipped?.name || '—', w.name).title}`;
  $('#dlg-skins').innerHTML = skins.map((s) => skinFrame(w, s)).join('');
  if (!$('#weapon-dialog').open) $('#weapon-dialog').showModal();
}

$('#dlg-skins').onclick = async (e) => {
  const sw = e.target.closest('[data-chroma]');
  if (sw) {
    pickedChroma.set(sw.dataset.for, sw.dataset.chroma);
    const w = collection.find((x) => x.uuid === openWeaponId);
    const s = w.skins.find((x) => x.uuid === sw.dataset.for);
    sw.closest('.frame').outerHTML = skinFrame(w, s);
    return;
  }
  const btn = e.target.closest('[data-equip]');
  if (!btn) return;
  const skinId = btn.dataset.equip;
  const w = collection.find((x) => x.uuid === openWeaponId);
  const s = w.skins.find((x) => x.uuid === skinId);
  btn.disabled = true; btn.textContent = '…';
  try {
    const r = await call('/api/equip', {
      weaponId: w.uuid, skinId, chromaId: pickedChroma.get(skinId) ?? s.variants[0]?.uuid,
    });
    toast(`${splitName(r.skin, r.weapon).title} équipé sur ${r.weapon}`);
    const data = await call('/api/collection');
    collection = data.weapons;
    pickedChroma.delete(skinId);
    openWeapon(w.uuid, { keepOpen: true });
    renderCollection();
  } catch (err) {
    toast(err.message, true);
    btn.disabled = false; btn.textContent = 'Réessayer';
  }
};

// ---------- navigation ----------
let currentTab = 'shop';
function showTab(tab) {
  currentTab = tab;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  if (relogin) return; // compte à reconnecter : on n'affiche pas les données d'un autre
  $('#login').classList.add('hidden');
  $('#shop').classList.toggle('hidden', tab !== 'shop');
  $('#collection').classList.toggle('hidden', tab !== 'collection');
  $('#live').classList.toggle('hidden', tab !== 'live');
  if (tab === 'collection') loadCollection().then(fitBoard);
  if (tab === 'live') startLive(); else stopLive();
}

// ---------- partie en cours ----------
let liveTimer = null;
let liveData = null;
let liveGen = 0;      // évite deux boucles de rafraîchissement en parallèle
let livePlayers = []; // joueurs affichés (index = data-idx des lignes)
function startLive() {
  stopLive();
  const gen = liveGen;
  if (!liveData) $('#live-body').innerHTML = '<div class="loading"><span class="lamp big"></span></div>';
  const tick = async () => {
    await loadLive();
    if (currentTab === 'live' && gen === liveGen) liveTimer = setTimeout(tick, 5000);
  };
  tick();
}
function stopLive() { liveGen++; clearTimeout(liveTimer); liveTimer = null; stopParty(); }

async function loadLive() {
  try {
    const res = await fetch('/api/live');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
    liveData = data;
    $('#live-dot').classList.toggle('hidden', data.state === 'menu');
    if (currentTab === 'live') renderLive(data);
  } catch (e) {
    if (currentTab === 'live') {
      stopParty();
      $('#live-sub').textContent = 'Infos indisponibles';
      $('#live-body').innerHTML = `<div class="live-empty"><span class="lamp big"></span>
        <p class="lede">Impossible de lire la partie.</p><p class="muted">${esc(e.message)}</p></div>`;
    }
  }
  $('#live-refresh').textContent = `Actualisé à ${new Date().toLocaleTimeString('fr-FR')}`;
}

// appel silencieux pour les routes optionnelles (pas de bascule vers l'écran de connexion)
async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}

// ---------- formats ----------
const titleCase = (n) => String(n).toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
const isNum = (v) => v != null && v !== '' && !Number.isNaN(+v);
const fr = (v, d = 0) => (isNum(v) ? (+v).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
// pourcentage : accepte 0–1 ou 0–100
const pct = (v) => (isNum(v) ? `${Math.round(+v > 0 && +v <= 1 ? +v * 100 : +v)} %` : '—');
const signed = (v) => (!isNum(v) ? '—' : +v > 0 ? `+${+v}` : +v < 0 ? `−${Math.abs(+v)}` : '0');
const winrate = (o) => (o?.matches ? (o.wins / o.matches) * 100 : o?.winrate);
const nameOf = (x) => (x && typeof x === 'object' ? x.name : x) || '';
const toMs = (v) => (v == null || v === '' ? null : typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v) || null);
const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
function shortDate(v) {
  const t = new Date(toMs(v) ?? v);
  return Number.isNaN(t.getTime()) ? '' : t.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}
const QUEUE_FR = {
  competitive: 'Compétition', unrated: 'Non classée', swiftplay: 'Vélocité', spikerush: 'Spike Rush',
  deathmatch: 'Combat à mort', ggteam: 'Escalade', hurm: 'Combat à mort par équipe', premier: 'Premier', all: 'Toutes',
};
const STAT_QUEUES = ['competitive', 'unrated', 'swiftplay', 'all'];

// compteurs à la seconde (sélection d'agent, recherche de partie)
setInterval(() => {
  document.querySelectorAll('[data-end]').forEach((el) => (el.textContent = `${Math.max(0, Math.ceil((+el.dataset.end - Date.now()) / 1000))}s`));
  document.querySelectorAll('[data-since]').forEach((el) => (el.textContent = clock(Date.now() - +el.dataset.since)));
}, 1000);

function rankLine(t, label) {
  return t ? `<span class="pl-mini" title="${esc(label)} : ${esc(t.name)}"><img src="${esc(t.icon)}" alt="">${esc(label)} <b>${esc(titleCase(t.name))}</b></span>` : '';
}

// ---------- stats des joueurs : une fois par session, 2 requêtes max en parallèle ----------
const pStats = new Map(); // puuid -> { status: 'wait'|'ok'|'err', data, at }
const pQueue = [];
let pActive = 0;
function wantStats(puuid, urgent = false) {
  if (!puuid) return;
  const hit = pStats.get(puuid);
  if (hit && !(hit.status === 'err' && Date.now() - hit.at > 120000)) {
    // joueur ouvert dans le panneau : on le passe devant
    const i = pQueue.indexOf(puuid);
    if (urgent && i > 0) { pQueue.splice(i, 1); pQueue.unshift(puuid); }
    return;
  }
  pStats.set(puuid, { status: 'wait' });
  if (urgent) pQueue.unshift(puuid); else pQueue.push(puuid);
  pumpStats();
}
function pumpStats() {
  while (pActive < 2 && pQueue.length) {
    const id = pQueue.shift();
    const my = epoch;
    pActive++;
    api(`/api/stats/player?puuid=${encodeURIComponent(id)}&n=5`)
      .then((data) => { if (my === epoch) pStats.set(id, { status: 'ok', data, at: Date.now() }); })
      .catch(() => { if (my === epoch) pStats.set(id, { status: 'err', at: Date.now() }); })
      .finally(() => { pActive--; if (my === epoch) paintStats(id); pumpStats(); });
  }
}
function statsLine(puuid) {
  const h = pStats.get(puuid);
  if (!h || h.status === 'wait') return '<span class="pl-stats-wait">Stats…</span>';
  if (h.status === 'err') return '<span class="pl-stats-wait">Stats indisponibles</span>';
  const s = h.data?.summary;
  if (!s?.matches) return '<span class="pl-stats-wait">Aucune partie récente</span>';
  return `K/D <b>${fr(s.kd, 2)}</b> · HS <b>${pct(s.hsPct)}</b> · <b>${s.wins ?? 0}V</b>/${s.matches}`;
}
function paintStats(puuid) {
  document.querySelectorAll(`.pl[data-puuid="${CSS.escape(puuid)}"] .pl-stats`).forEach((el) => (el.innerHTML = statsLine(puuid)));
  if (pdPlayer?.puuid === puuid) paintPlayerStats();
}

function playerRow(p, pregame, idx) {
  const r = p.rank || {};
  const cur = r.current;
  const name = p.name
    ? esc(p.name.split('#')[0]) + `<small>#${esc(p.name.split('#')[1] || '')}</small>`
    : `<span class="pl-hidden">Joueur masqué</span>`;
  const tags = (p.party ? '<span class="pl-tag">Groupe</span>' : '') + (p.self ? '<span class="pl-tag glow">Toi</span>' : '');
  const sub = [
    p.agent ? esc(p.agent.name) : (pregame ? 'Sélection…' : ''),
    p.level ? `Niv. ${p.level}` : '', // 0 = inconnu
  ].filter(Boolean).join(' · ');
  const wr = r.games ? `${Math.round((r.wins / r.games) * 100)} % · ${r.games} parties` : '';
  const sk = p.skins || {};
  const skin = sk.vandal || sk.phantom || sk.operator || sk.melee;
  return `
    <article class="pl ${p.self ? 'me' : ''} ${pregame && p.lock !== 'locked' ? 'picking' : ''}" data-idx="${idx}"
      ${p.puuid ? `data-puuid="${esc(p.puuid)}"` : ''} tabindex="0" role="button" aria-label="Détails : ${esc(p.name || 'joueur masqué')}">
      <div class="pl-agent">${p.agent ? `<img src="${esc(p.agent.icon)}" alt="">` : '<span>?</span>'}</div>
      <div class="pl-id">
        <div class="pl-name"><span class="pl-nm">${name}</span>${tags}</div>
        <div class="pl-sub">${sub}${pregame && p.lock && p.lock !== 'locked' ? ' · <em>en sélection</em>' : ''}</div>
        ${p.puuid ? `<div class="pl-stats">${statsLine(p.puuid)}</div>` : ''}
      </div>
      <div class="pl-rank">
        ${cur
          ? `<img class="pl-rank-icon" src="${esc(cur.icon)}" alt=""><div><b style="color:${esc(cur.color)}">${esc(cur.name)}</b><span>${r.rr ?? 0} RR${wr ? ` · ${wr}` : ''}</span></div>`
          : '<div><b class="muted">Non classé</b><span>—</span></div>'}
        <div class="pl-history">${rankLine(r.peak, 'Pic')}${rankLine(r.previous, 'Préc.')}</div>
      </div>
      <div class="pl-skin" title="${skin ? esc(skin.name) : ''}">${skin ? `<img src="${esc(skin.image)}" alt="">` : ''}</div>
    </article>`;
}

function renderLive(d) {
  if (d.state === 'menu' || d.state === 'offline') {
    // "offline" : le compte sélectionné n'est pas celui du Riot Client → seulement ses stats
    const solo = d.state === 'offline';
    $('#live-sub').textContent = !solo ? 'Dans les menus'
      : d.reason === 'other-account' ? 'Compte non connecté au Riot Client' : 'Riot Client non détecté';
    // le tableau de bord n'est construit qu'une fois par mode (le refresh de 5 s ne le reconstruit pas)
    const mode = solo ? 'solo' : 'full';
    if ($('#menu-dash')?.dataset.mode !== mode) {
      $('#live-body').innerHTML = solo
        ? '<div class="dash solo" id="menu-dash" data-mode="solo"><section class="dash-stats" id="mystats"></section></div>'
        : `<div class="dash" id="menu-dash" data-mode="full">
          <section class="dash-play" id="play"></section>
          <section class="dash-stats" id="mystats"></section>
        </div>`;
      partyKey = '';
      if (!solo) renderPlay();
      renderMyStats();
      loadMyStats();
    }
    fitDash();
    if (solo) stopParty(); else startParty();
    return;
  }
  stopParty();
  const pregame = d.state === 'pregame';
  $('#live-sub').textContent = pregame ? 'Sélection des agents' : 'Partie en cours';
  livePlayers = [...d.allies, ...d.enemies];
  livePlayers.forEach((p) => wantStats(p.puuid));
  // en sélection : le chrono d'abord (le score vaut 0–0)
  const disc = pregame && d.phaseRemaining != null
    ? `<div class="live-disc"><span>Sélection</span><b data-end="${Date.now() + d.phaseRemaining * 1000}">${d.phaseRemaining}s</b></div>`
    : d.score
      ? `<div class="live-disc"><span>Score</span><b>${d.score.ally}<i>—</i>${d.score.enemy}</b></div>`
      : '';
  const facts = [
    ['Mode', d.mode], ['Serveur', d.server], ['Départ', d.allySide],
  ].filter(([, v]) => v).map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join('');
  const n = d.allies.length;
  $('#live-body').innerHTML = `
    <div class="live-head">
      <div class="live-map" ${d.map?.list ? `style="background-image:url('${esc(d.map.list)}')"` : ''}>
        <h2>${esc(d.map?.name || 'Carte')}</h2>
      </div>
      <div class="live-facts">${facts}</div>
      ${disc}
    </div>
    <div class="live-teams">
      <section class="team ally">
        <h2><span><i class="glow-dot"></i>Ton équipe</span><em>${n} joueurs</em></h2>
        ${d.allies.map((p, i) => playerRow(p, pregame, i)).join('')}
      </section>
      <section class="team">
        <h2><span>Adversaires</span><em>${d.enemies.length ? `${d.enemies.length} joueurs` : ''}</em></h2>
        ${d.enemies.length
          ? d.enemies.map((p, i) => playerRow(p, false, n + i)).join('')
          : '<p class="empty">Les adversaires apparaîtront au lancement de la partie.</p>'}
      </section>
    </div>`;
}

// Le tableau de bord prend la hauteur restante : pas de scroll de page.
function fitDash() {
  const dash = $('#menu-dash');
  if (!dash || !dash.offsetParent) return;
  if (innerWidth <= 1000) { dash.style.removeProperty('--dash-h'); return; }
  const top = dash.getBoundingClientRect().top + window.scrollY;
  const h = innerHeight - top - 16;
  dash.style.setProperty('--dash-h', `${Math.max(480, h)}px`);
  const over = document.documentElement.scrollHeight - innerHeight;
  if (over > 0) dash.style.setProperty('--dash-h', `${Math.max(480, h - over)}px`);
}
window.addEventListener('resize', fitDash);

// ---------- Jouer : groupe, mode, recherche ----------
let partyData = null, partyErr = null, partyBusy = false, partyKey = '';
let partyOn = false, partyTimer = null, partyGen = 0, mmSeenAt = null;
function startParty() {
  if (partyOn) return;
  partyOn = true;
  const gen = ++partyGen;
  const tick = async () => {
    await loadParty();
    if (partyOn && gen === partyGen) partyTimer = setTimeout(tick, 3000);
  };
  tick();
}
function stopParty() { partyOn = false; partyGen++; clearTimeout(partyTimer); partyTimer = null; }

async function loadParty() {
  const my = epoch;
  try {
    const d = await api('/api/party');
    if (my !== epoch || partyBusy) return; // une action en cours fait foi
    partyData = d; partyErr = null;
  } catch (e) {
    if (my !== epoch) return;
    partyErr = e.message;
  }
  renderPlay();
}

async function partyAction(kind, body) {
  if (partyBusy) return;
  const path = { launch: '/api/game/launch', start: '/api/party/start', stop: '/api/party/stop', queue: '/api/party/queue' }[kind];
  if (!path) return;
  partyBusy = true; renderPlay();
  try {
    const r = await api(path, body ?? {});
    if (kind === 'launch') toast('Lancement de Valorant…');
    else if (r && typeof r === 'object' && 'state' in r) { partyData = r; partyErr = null; }
  } catch (e) {
    toast(e.message, true);
  }
  partyBusy = false;
  renderPlay();
}

function renderPlay() {
  const el = $('#play');
  if (!el) return;
  const p = partyData;
  const key = JSON.stringify([p, partyErr, partyBusy]);
  if (key === partyKey) return; // rien de neuf : on ne touche pas au DOM
  partyKey = key;
  const mm = p?.state === 'MATCHMAKING';
  if (!mm) mmSeenAt = null; else if (!mmSeenAt) mmSeenAt = Date.now();
  const label = !p ? '' : !p.gameRunning ? 'Jeu fermé' : mm ? 'En recherche' : (p.queueLabel || '');
  const head = `<h2 class="dash-h"><span><i class="glow-dot"></i>Jouer</span><em>${esc(label)}</em></h2>`;

  if (!p) {
    el.innerHTML = head + (partyErr
      ? `<div class="dash-wait"><span class="lamp"></span><p class="empty">Commandes de jeu indisponibles.</p><p class="muted">${esc(partyErr)}</p></div>`
      : '<div class="dash-wait"><span class="lamp big"></span></div>');
    return;
  }
  const stale = partyErr ? `<p class="play-note">Client injoignable : dernières infos connues.</p>` : '';
  if (!p.gameRunning) {
    el.innerHTML = head + `
      <div class="play-launch">
        <span class="lamp big"></span>
        <p class="lede">Valorant n'est pas lancé.</p>
        <button class="btn primary big" data-party="launch" ${partyBusy ? 'disabled' : ''}>Lancer Valorant</button>
        ${p.clientRunning ? '' : '<p class="play-note">Riot Client non détecté sur ce PC.</p>'}
        ${stale}
      </div>`;
    return;
  }
  const owner = p.isOwner !== false;
  const canQ = owner && p.canChangeQueue !== false && !mm && !partyBusy;
  const pills = (p.queues || []).map((q) => `
    <button class="pill ${q.id === p.queueId ? 'on' : ''}" data-queue="${esc(q.id)}" title="${esc(q.label)}"
      ${q.eligible === false || !canQ ? 'disabled' : ''}>${esc(q.label)}</button>`).join('');
  const members = (p.members || []).map((m) => `
    <li class="${m.isReady ? 'ready' : ''}" title="${m.isReady ? 'Prêt' : 'Pas prêt'}">
      <i></i><span class="pm-name">${m.name ? esc(m.name.split('#')[0]) : 'Joueur'}</span>
      ${m.isOwner ? '<span class="pl-tag">Chef</span>' : ''}${m.level ? `<small>Niv. ${m.level}</small>` : ''}
    </li>`).join('');
  const since = toMs(p.queueSince) || mmSeenAt || Date.now();
  const go = mm
    ? `<div class="mm">
        <div class="live-disc"><span>Recherche</span><b data-since="${since}">${clock(Date.now() - since)}</b></div>
        <button class="btn" data-party="stop" ${partyBusy ? 'disabled' : ''}>Annuler</button>
      </div>`
    : `<button class="btn primary big" data-party="start" ${!owner || partyBusy ? 'disabled' : ''}>Lancer la recherche</button>`;
  el.innerHTML = head + `
    <p class="play-label"><span>Mode</span></p>
    <div class="pills">${pills || '<span class="play-note">Aucun mode disponible.</span>'}</div>
    ${owner ? '' : '<p class="play-note">Seul le chef du groupe peut changer de mode et lancer la recherche.</p>'}
    <p class="play-label"><span>Groupe</span><span>${(p.members || []).length || ''}</span></p>
    <ul class="members">${members || '<li class="play-note">Pas de groupe détecté.</li>'}</ul>
    ${stale}
    <div class="play-go">${go}</div>`;
}

// ---------- Mes stats ----------
const myStats = {}; // file -> { status: 'loading'|'ok'|'err', data, prev, err }
let statsQueue = 'competitive';
async function loadMyStats(force = false) {
  const q = statsQueue;
  const st = myStats[q];
  if (st?.status === 'loading' || (!force && st?.status === 'ok')) return;
  myStats[q] = { status: 'loading', prev: st?.data || st?.prev };
  renderMyStats();
  const my = epoch;
  try {
    const data = await api(`/api/stats/me?queue=${q}&n=20`);
    if (my !== epoch) return;
    myStats[q] = { status: 'ok', data };
  } catch (e) {
    if (my !== epoch) return;
    myStats[q] = { status: 'err', err: e.message, prev: myStats[q]?.prev };
  }
  if (q === statsQueue) renderMyStats();
}

function matchRow(m, focus) {
  const res = m.draw ? 'draw' : m.won ? 'win' : 'loss';
  const rr = isNum(m.rrChange) ? `<b class="mt-rr ${+m.rrChange > 0 ? 'up' : +m.rrChange < 0 ? 'down' : ''}">${signed(m.rrChange)}</b>` : '<b class="muted">—</b>';
  const what = [QUEUE_FR[m.mode] ?? m.mode, shortDate(m.date)].filter(Boolean).join(' · ');
  return `
    <div class="mt ${res}" data-match="${esc(m.id)}"${focus ? ` data-focus="${esc(focus)}"` : ''} tabindex="0" role="button" title="Voir le détail de la partie">
      <span class="mt-map" ${m.map?.image ? `style="background-image:url('${esc(m.map.image)}')"` : ''}></span>
      ${m.agent?.icon ? `<img class="mt-agent" src="${esc(m.agent.icon)}" alt="" title="${esc(m.agent.name)}">` : '<span class="mt-agent"></span>'}
      <span class="mt-res"><b>${m.draw ? 'N' : m.won ? 'V' : 'D'}</b>${m.score ? `${m.score.ally}–${m.score.enemy}` : ''}</span>
      <span class="mt-what"><b>${esc(nameOf(m.map) || '—')}</b><small>${esc(what)}</small></span>
      <span class="mt-n"><b>${m.kills ?? '—'}/${m.deaths ?? '—'}/${m.assists ?? '—'}</b><small>KDA</small></span>
      <span class="mt-n"><b>${fr(m.acs)}</b><small>ACS</small></span>
      <span class="mt-n"><b>${pct(m.hsPct)}</b><small>HS</small></span>
      <span class="mt-n">${rr}<small>RR</small></span>
    </div>`;
}

function topRow(x, kind) {
  const wr = winrate(x);
  const pic = kind === 'map'
    ? `<span class="ag-map" ${x.image ? `style="background-image:url('${esc(x.image)}')"` : ''}></span>`
    : (x.icon ? `<img src="${esc(x.icon)}" alt="">` : '<span class="ag-map"></span>');
  return `
    <div class="ag ${kind}" style="--w:${isNum(wr) ? Math.max(0, Math.min(100, Math.round(wr > 1 ? wr : wr * 100))) : 0}%">
      ${pic}<span class="ag-name">${esc(x.name)}</span>
      <span class="ag-wr">${pct(wr)}</span><span class="ag-n">${x.matches ?? 0} p.</span>
    </div>`;
}

function renderMyStats() {
  const el = $('#mystats');
  if (!el) return;
  const st = myStats[statsQueue];
  const data = st?.status === 'ok' ? st.data : st?.prev;
  const loadingNow = st?.status === 'loading';
  const head = `
    <div class="dash-h stats-h">
      <span>Mes stats</span>
      <div class="segs">${STAT_QUEUES.map((q) => `<button class="seg ${q === statsQueue ? 'on' : ''}" data-stq="${q}">${QUEUE_FR[q]}</button>`).join('')}</div>
      <button class="link-btn" data-act="stats-refresh" ${loadingNow ? 'disabled' : ''}>${loadingNow ? 'Actualisation…' : 'Actualiser'}</button>
    </div>`;
  let body;
  if (!data && loadingNow) {
    body = `<div class="dash-wait"><span class="lamp big"></span><p class="lede">Lecture de tes parties…</p>
      <p class="muted">La première fois, ça peut prendre un moment.</p></div>`;
  } else if (!data) {
    body = `<div class="dash-wait"><span class="lamp"></span><p class="empty">Stats indisponibles.</p>
      ${st?.err ? `<p class="muted">${esc(st.err)}</p>` : ''}</div>`;
  } else if (!data.summary?.matches) {
    body = '<div class="dash-wait"><span class="lamp"></span><p class="empty">Aucune partie récente dans ce mode.</p></div>';
  } else {
    body = statsBody(data);
  }
  el.innerHTML = head + body;
}

function statsBody(d) {
  const s = d.summary;
  const rrCls = isNum(d.rrNet) && +d.rrNet > 0 ? 'up' : '';
  const nums = [['K/D', fr(s.kd, 2)], ['HS', pct(s.hsPct)], ['ADR', fr(s.adr)], ['ACS', fr(s.acs)], ['RR net', signed(d.rrNet), rrCls]];
  const rk = d.player?.rank?.current || null;
  const line = [
    rk?.name ? `${rk.icon ? `<img src="${esc(rk.icon)}" alt="">` : ''}<b>${esc(titleCase(rk.name))}</b>` : '',
    `<b>${s.matches}</b> parties`,
    `${s.wins ?? 0} V – ${s.losses ?? 0} D${s.draws ? ` – ${s.draws} N` : ''}`,
    isNum(s.kda) ? `KDA ${fr(s.kda, 2)}` : '',
    d.streak?.count ? `série : <b>${d.streak.count} ${d.streak.type === 'W' ? 'victoire' : 'défaite'}${d.streak.count > 1 ? 's' : ''}</b>` : '',
    d.longestWinStreak ? `record : ${d.longestWinStreak} V d'affilée` : '',
  ].filter(Boolean).join('<i>·</i>');
  const cool = [...(d.cool || [])];
  if (d.best) {
    const b = d.best;
    cool.unshift({ label: 'Meilleure partie', value: `${b.kills}/${b.deaths}/${b.assists}`, detail: [nameOf(b.agent), nameOf(b.map), isNum(b.acs) ? `${fr(b.acs)} ACS` : ''].filter(Boolean).join(' · ') });
  }
  return `
    <div class="ms-top">
      <div class="live-disc ms-disc"><span>Victoires</span><b>${pct(winrate(s))}</b></div>
      <div class="ms-nums">
        <div class="ms-row">${nums.map(([k, v, c]) => `<div class="ms-num ${c || ''}"><b>${v}</b><span>${k}</span></div>`).join('')}</div>
        <p class="ms-line">${line}</p>
      </div>
    </div>
    ${cool.length ? `<div class="ms-cool">${cool.slice(0, 6).map((c) => `
      <div class="cool" title="${esc([c.label, c.value, c.detail].filter(Boolean).join(' — '))}">
        <span>${esc(c.label)}</span><b>${esc(c.value)}</b>${c.detail ? `<small>${esc(c.detail)}</small>` : ''}
      </div>`).join('')}</div>` : ''}
    <div class="ms-bottom">
      <div class="ms-side">
        <h3 class="ms-h">Agents<em>victoires · parties</em></h3>
        ${(d.agents || []).slice(0, 4).map((a) => topRow(a, 'agent')).join('') || '<p class="play-note">—</p>'}
        <h3 class="ms-h">Cartes</h3>
        ${(d.maps || []).slice(0, 4).map((m) => topRow(m, 'map')).join('') || '<p class="play-note">—</p>'}
      </div>
      <div class="ms-matches">
        <h3 class="ms-h">Dernières parties<em>${(d.matches || []).length}</em></h3>
        <div class="mt-list">${(d.matches || []).map((m) => matchRow(m)).join('')}</div>
      </div>
    </div>`;
}

// ---------- panneau joueur ----------
let pdPlayer = null;
const rankBox = (t, label) => `<div><span>${label}</span>${t ? `<b><img src="${esc(t.icon)}" alt="">${esc(titleCase(t.name))}</b>` : '<b class="muted">—</b>'}</div>`;

function openPlayer(idx) {
  const p = livePlayers[idx];
  if (!p) return;
  pdPlayer = p;
  wantStats(p.puuid, true);
  const [gn, tag] = p.name ? p.name.split('#') : [];
  const r = p.rank || {};
  const cur = r.current;
  const wr = r.games ? `${Math.round((r.wins / r.games) * 100)} % de victoires · ${r.games} parties` : 'Aucune partie classée cet acte';
  $('#pd-who').innerHTML = `
    <div class="pd-agent">${p.agent ? `<img src="${esc(p.agent.icon)}" alt="">` : '<span>?</span>'}</div>
    <div class="pd-id">
      <p class="kicker">${[p.agent?.name, p.agent?.role, p.level ? `Niv. ${p.level}` : '', p.self ? 'Toi' : p.ally ? 'Ton équipe' : 'Adversaire'].filter(Boolean).map(esc).join(' · ')}</p>
      <h2 class="poster">${p.name ? `${esc(gn)}<small>#${esc(tag || '')}</small>` : '<span class="pl-hidden">Joueur masqué</span>'}</h2>
    </div>`;
  $('#pd-body').innerHTML = `
    <div class="pd-top">
      <div class="pd-left">
        <div class="pd-rank">
          ${cur ? `<img src="${esc(cur.icon)}" alt="">` : ''}
          <div><b ${cur ? `style="color:${esc(cur.color)}"` : 'class="muted"'}>${cur ? esc(titleCase(cur.name)) : 'Non classé'}</b>
          <span>${cur ? `${r.rr ?? 0} RR · ` : ''}${wr}</span></div>
        </div>
        <div class="pd-hist">${rankBox(r.peak, 'Pic')}${rankBox(r.previous, 'Acte précédent')}</div>
        <div id="pd-sum"></div>
      </div>
      <div class="pd-right" id="pd-matches"></div>
    </div>
    <h3 class="ms-h">Équipement de la partie</h3>
    ${loadoutGrid(p.loadout)}
    <p class="pd-note">Riot n'expose que les skins équipés pour cette partie, pas la collection complète du joueur.</p>`;
  paintPlayerStats();
  if (!$('#player-dialog').open) $('#player-dialog').showModal();
}

function paintPlayerStats() {
  const sum = $('#pd-sum'), list = $('#pd-matches');
  if (!sum || !list || !pdPlayer) return;
  const h = pdPlayer.puuid ? pStats.get(pdPlayer.puuid) : { status: 'err' };
  const head = `<h3 class="ms-h">Dernières parties<em>${h?.data?.queue ? esc(QUEUE_FR[h.data.queue] ?? h.data.queue) : ''}</em></h3>`;
  if (!h || h.status === 'wait') {
    sum.innerHTML = '';
    list.innerHTML = head + '<div class="dash-wait small"><span class="lamp"></span><p class="play-note">Chargement des stats…</p></div>';
    return;
  }
  if (h.status === 'err') {
    sum.innerHTML = '';
    list.innerHTML = head + '<div class="dash-wait small"><span class="lamp"></span><p class="play-note">Stats indisponibles.</p></div>';
    return;
  }
  const d = h.data || {};
  const s = d.summary;
  sum.innerHTML = s?.matches ? `
    <div class="ms-row pd-nums">
      ${[['Victoires', pct(winrate(s))], ['K/D', fr(s.kd, 2)], ['HS', pct(s.hsPct)], ['ACS', fr(s.acs)], ['ADR', fr(s.adr)]]
        .map(([k, v]) => `<div class="ms-num"><b>${v}</b><span>${k}</span></div>`).join('')}
    </div>
    <p class="ms-line"><b>${s.matches}</b> parties<i>·</i>${s.wins ?? 0} V – ${s.losses ?? 0} D${d.streak?.count ? `<i>·</i>série : <b>${d.streak.count} ${d.streak.type === 'W' ? 'V' : 'D'}</b>` : ''}</p>
    ${(d.agents || []).length ? `<div class="pd-agents">${d.agents.slice(0, 3).map((a) => topRow(a, 'agent')).join('')}</div>` : ''}` : '';
  list.innerHTML = head + ((d.matches || []).length
    ? `<div class="mt-list">${d.matches.slice(0, 5).map((m) => matchRow(m, pdPlayer?.puuid)).join('')}</div>`
    : '<p class="play-note">Aucune partie récente.</p>');
}

// équipement complet, rangé comme le menu d'achat
function loadoutGrid(lo) {
  if (!Array.isArray(lo) || !lo.length) return '<p class="play-note">Équipement indisponible pour ce joueur.</p>';
  const cat = (w) => String(w?.category || '').replace(/^.*::/, '');
  const cols = BOARD.map((col) => col.map((g) => ({ ...g, items: [] })));
  const other = { label: 'Autres', order: [], items: [] };
  for (const it of lo) {
    const g = cols.flat().find((x) => x.cat === cat(it.weapon));
    (g || other).items.push(it);
  }
  if (other.items.length) cols[cols.length - 1].push(other);
  const item = (it) => {
    const wn = it.weapon?.name || '';
    const sk = it.skin || {};
    const title = sk.isDefault ? 'Standard' : splitName(sk.name || wn, wn).title || wn;
    const img = sk.image || it.weapon?.icon;
    return `
      <div class="lo-item ${sk.isDefault ? 'is-default' : ''}" title="${esc(sk.name || wn)}">
        <div class="lo-img">${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : ''}</div>
        <div class="lo-txt"><b>${esc(title)}</b><span>${esc(wn)}</span></div>
      </div>`;
  };
  return `<div class="lo">${cols.map((col) => `
    <div class="lo-col">${col.filter((g) => g.items.length).map((g) => {
      const rank = (it) => { const i = g.order.indexOf(it.weapon?.name); return i < 0 ? 99 : i; };
      return `<section class="lo-group"><h4>${esc(g.label)}</h4>${g.items.sort((a, b) => rank(a) - rank(b)).map(item).join('')}</section>`;
    }).join('')}</div>`).join('')}</div>`;
}

// clics dans l'onglet En jeu (délégation : le contenu est régénéré)
$('#live-body').addEventListener('click', (e) => {
  const q = e.target.closest('[data-queue]');
  if (q) { if (q.dataset.queue !== partyData?.queueId) partyAction('queue', { queueId: q.dataset.queue }); return; }
  const a = e.target.closest('[data-party]');
  if (a) { partyAction(a.dataset.party); return; }
  const sq = e.target.closest('[data-stq]');
  if (sq) { statsQueue = sq.dataset.stq; renderMyStats(); loadMyStats(); return; }
  if (e.target.closest('[data-act="stats-refresh"]')) { loadMyStats(true); return; }
  const row = e.target.closest('.pl[data-idx]');
  if (row) openPlayer(+row.dataset.idx);
});
$('#live-body').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('.pl[data-idx]')) {
    e.preventDefault();
    openPlayer(+e.target.dataset.idx);
  }
});
$('#pd-close').onclick = () => $('#player-dialog').close();
$('#player-dialog').onclick = (e) => { if (e.target.id === 'player-dialog') e.target.close(); };
$('#player-dialog').addEventListener('close', () => { pdPlayer = null; });

// changement de compte : on oublie tout ce qui concerne l'ancien
function resetLiveCaches() {
  stopParty();
  pStats.clear(); pQueue.length = 0;
  for (const k of Object.keys(myStats)) delete myStats[k];
  partyData = null; partyErr = null; partyKey = ''; mmSeenAt = null;
  liveData = null; livePlayers = [];
  if ($('#player-dialog').open) $('#player-dialog').close();
  $('#live-body').innerHTML = '';
}

// détection de partie en arrière-plan (point orange sur l'onglet "En jeu")
setInterval(() => { if (currentTab !== 'live' && accounts.length) loadLive(); }, 30000);

// addMode : écran de connexion affiché pour ajouter un compte (on garde l'en-tête et le sélecteur)
function showLogin(err, { addMode = false } = {}) {
  hideRelogin();
  closeAcctMenu();
  stopLive();
  const hide = ['#shop', '#collection', '#live'].concat(addMode ? [] : ['#tabs', '#account', '#acct']);
  hide.forEach((s) => $(s).classList.add('hidden'));
  $('#login').classList.remove('hidden');
  $('#login-error').textContent = err || '';
  if (!addMode) { $('#player').textContent = ''; collection = null; }
}

async function showApp() {
  $('#login').classList.add('hidden');
  ['#tabs', '#account', '#acct'].forEach((s) => $(s).classList.remove('hidden'));
  await refreshAccounts().catch(() => {});
  hideRelogin();
  showTab(currentTab);
  await loadShop();
}

// ---------- comptes ----------
let accounts = [];
let riotAvailable = false;
let relogin = false; // le compte actif doit se reconnecter
let epoch = 0;       // change à chaque changement de compte (ignore les réponses périmées)
let acctBusy = false;
const activeAcct = () => accounts.find((a) => a.active) || null;

async function refreshAccounts(data) {
  if (!data) data = await fetch('/api/accounts').then((r) => r.json());
  if (Array.isArray(data?.accounts)) accounts = data.accounts;
  renderAccounts();
}

function renderAccounts() {
  const act = activeAcct();
  $('#acct-name').textContent = act?.name || 'Compte Riot';
  $('#acct-dot').classList.toggle('off', !act || act.relogin);
  $('#player').textContent = act
    ? [act.name, act.region && `Édition ${act.region.toUpperCase()}`].filter(Boolean).join(' · ')
    : '';
  $('#acct-menu').innerHTML = `
    <div class="acct-label">Comptes</div>
    ${accounts.map((a) => `
      <button class="acct-item ${a.active ? 'active' : ''}" role="menuitem" data-acct="${esc(a.id)}">
        <i class="acct-dot"></i>
        <span class="acct-id">${esc(a.name || 'Compte Riot')}</span>
        <span class="acct-meta">${a.region ? esc(a.region.toUpperCase()) : ''}</span>
        ${a.relogin ? '<span class="acct-warn">Reconnexion requise</span>' : ''}
      </button>`).join('')}
    <div class="acct-sep"></div>
    <button class="acct-action" role="menuitem" data-act="add">Ajouter un compte</button>
    <button class="acct-action danger" role="menuitem" data-act="logout">Se déconnecter de ce compte</button>`;
}

function openAcctMenu() {
  $('#acct-menu').classList.remove('hidden');
  $('#acct-btn').setAttribute('aria-expanded', 'true');
}
function closeAcctMenu() {
  $('#acct-menu').classList.add('hidden');
  $('#acct-btn').setAttribute('aria-expanded', 'false');
}
$('#acct-btn').onclick = () => ($('#acct-menu').classList.contains('hidden') ? openAcctMenu() : closeAcctMenu());
document.addEventListener('click', (e) => { if (!e.target.closest('#acct')) closeAcctMenu(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#acct-menu').classList.contains('hidden')) { closeAcctMenu(); $('#acct-btn').focus(); }
});

function showRelogin(msg) {
  relogin = true;
  collection = null;
  ['#shop', '#collection', '#live'].forEach((s) => $(s).classList.add('hidden'));
  stopLive();
  $('#wallet').innerHTML = '';
  $('#relogin-msg').textContent = msg || 'Ce compte doit se reconnecter.';
  $('#relogin-banner').classList.remove('hidden');
}
function hideRelogin() {
  relogin = false;
  $('#relogin-banner').classList.add('hidden');
}

// Nouveau compte actif : on vide ce qui appartenait à l'ancien et on recharge
async function onAccountChanged() {
  epoch++;
  hideRelogin();
  collection = null; openWeaponId = null; pickedChroma.clear();
  if ($('#weapon-dialog').open) $('#weapon-dialog').close();
  resetLiveCaches();
  $('#wallet').innerHTML = '';
  ['#daily', '#night', '#bundles'].forEach((s) => ($(s).innerHTML = ''));
  setError('');
  renderAccounts();
  showTab(currentTab); // recharge la collection si cet onglet est ouvert
  await loadShop();
}

// Action de compte (changement, ajout, reconnexion, retrait) : un seul à la fois
async function accountAction(path, body, { busyMsg, doneMsg } = {}) {
  if (acctBusy) return;
  acctBusy = true;
  if (busyMsg) toast(busyMsg);
  try {
    const data = await call(path, body);
    await refreshAccounts(data);
    if (!accounts.length) showLogin();
    else { $('#login').classList.add('hidden'); await onAccountChanged(); }
    if (doneMsg) toast(doneMsg);
  } catch (e) {
    // 401 sur un changement : le compte est devenu actif mais doit se reconnecter (bandeau déjà affiché)
    if (!e.handled) toast(e.message, true);
    else if (relogin) { epoch++; loading(false); }
  }
  acctBusy = false;
}
const reloginAccount = (id) => accountAction('/api/accounts/relogin', { id }, { busyMsg: 'Fenêtre de connexion Riot ouverte…', doneMsg: 'Compte reconnecté' });

$('#acct-menu').onclick = (e) => {
  const item = e.target.closest('[data-acct]');
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (item) {
    const a = accounts.find((x) => x.id === item.dataset.acct);
    closeAcctMenu();
    if (!a) return;
    if (a.relogin) reloginAccount(a.id);
    else if (!a.active) accountAction('/api/accounts/switch', { id: a.id });
  } else if (act === 'add') {
    closeAcctMenu();
    // hors app Electron il n'y a pas de fenêtre Riot : on réutilise l'écran de connexion (Riot Client / URL)
    if (riotAvailable) accountAction('/api/accounts/add', {}, { busyMsg: 'Fenêtre de connexion Riot ouverte…' });
    else showLogin('', { addMode: true });
  } else if (act === 'logout') {
    closeAcctMenu();
    accountAction('/api/logout', {});
  }
};
$('#relogin-btn').onclick = () => { const a = activeAcct(); if (a) reloginAccount(a.id); };

async function doLogin(path, body, btn) {
  btn.disabled = true; $('#login-error').textContent = '';
  try {
    await call(path, { ...body, region: $('#region').value });
    await showApp();
  } catch (e) { $('#login-error').textContent = e.message; }
  btn.disabled = false;
}

$('#login-riot').onclick = (e) => doLogin('/api/login/riot', {}, e.currentTarget);
$('#login-local').onclick = (e) => doLogin('/api/login/local', {}, e.currentTarget);
$('#login-url').onclick = (e) => doLogin('/api/login/url', { url: $('#redirect-url').value }, e.currentTarget);
$('#refresh-shop').onclick = loadShop;
document.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = (e) => {
  e.preventDefault();
  if (!$('#tabs').classList.contains('hidden')) showTab(b.dataset.tab);
}));
$('#search').oninput = () => collection && renderCollection();
$('#owned-only').onchange = () => collection && renderCollection();
$('#board').onclick = (e) => {
  const btn = e.target.closest('[data-weapon]');
  if (btn) openWeapon(btn.dataset.weapon);
};
$('#dlg-close').onclick = () => $('#weapon-dialog').close();
$('#weapon-dialog').onclick = (e) => { if (e.target.id === 'weapon-dialog') e.target.close(); };

// ---------- démarrage ----------
(async () => {
  const st = await fetch('/api/status').then((r) => r.json()).catch(() => ({}));
  $('#riot-link').href = st.loginUrl || '#';
  riotAvailable = !!st.riotLoginAvailable;
  if (st.riotLoginAvailable) {
    $('#riot-card').classList.remove('hidden');
    $('#paste-card').classList.add('hidden');
    $('#local-tag').classList.add('hidden');
  }
  // au moins un compte (même à reconnecter) : on affiche l'appli, le bandeau proposera la reconnexion
  if (st.accounts?.length) showApp(); else showLogin();
})();

// ---------- contenu d'un pack de la boutique ----------
let shopBundles = [];
function bundlePrice(it) {
  const p = it.price;
  const price = p
    ? `${p.toLocaleString('fr-FR')}${it.basePrice && it.basePrice > p ? ` <s>${it.basePrice.toLocaleString('fr-FR')}</s>` : ''} <small>VP</small>`
    : '<small>Uniquement dans le pack</small>';
  return `<div class="foot"><span class="price">${price}</span>${it.amount > 1 ? `<span class="note">×${it.amount}</span>` : ''}</div>`;
}
function openBundle(i) {
  const b = shopBundles[i];
  if (!b) return;
  const n = (b.items || []).length;
  $('#bd-title').textContent = b.name;
  $('#bd-sub').textContent = `${n} objet${n > 1 ? 's' : ''} · ${b.price.toLocaleString('fr-FR')} VP le pack`
    + (b.basePrice && b.basePrice > b.price ? ` au lieu de ${b.basePrice.toLocaleString('fr-FR')}` : '');
  $('#bd-items').innerHTML = (b.items || []).map((it) => {
    if (it.kind === 'skin') return frame(it, { weapon: it.weapon, owned: it.owned, controls: bundlePrice(it) });
    return `
      <article class="frame cos cos-${esc(it.kind)}">
        <div class="mat">${it.image ? `<img src="${esc(it.image)}" alt="" loading="lazy">` : `<span class="cos-title">« ${esc(it.name)} »</span>`}</div>
        <div class="caption">
          <div class="meta-line"><i class="tier-dot"></i>${esc(it.kindLabel)}</div>
          <h3>${esc(it.name)}</h3>
          ${bundlePrice(it)}
        </div>
      </article>`;
  }).join('') || '<p class="empty">Contenu indisponible.</p>';
  if (!$('#bundle-dialog').open) $('#bundle-dialog').showModal();
}
$('#bundles').addEventListener('click', (e) => {
  const b = e.target.closest('[data-bundle]');
  if (b) openBundle(+b.dataset.bundle);
});
$('#bundles').addEventListener('keydown', (e) => {
  const b = e.target.closest('[data-bundle]');
  if (b && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openBundle(+b.dataset.bundle); }
});
$('#bd-close').onclick = () => $('#bundle-dialog').close();
$('#bundle-dialog').onclick = (e) => { if (e.target.id === 'bundle-dialog') e.target.close(); };

// ---------- détail d'une partie : tableau, rounds, duels ----------
let mdData = null, mdTab = 'board', mdRound = 0, mdReq = 0;
const pName = (p) => (p?.name ? esc(p.name.split('#')[0]) : esc(p?.agent?.name || 'Joueur'));
const pIcon = (p) => (p?.agent?.icon ? `<img src="${esc(p.agent.icon)}" alt="">` : '<i class="no-icon"></i>');

async function openMatch(id, focus) {
  const req = ++mdReq;
  mdData = null; mdTab = 'board'; mdRound = 0;
  $('#md-who').innerHTML = '<p class="kicker">Chargement de la partie…</p>';
  $('#md-body').innerHTML = '<div class="dash-wait small"><span class="lamp big"></span></div>';
  if (!$('#match-dialog').open) $('#match-dialog').showModal();
  try {
    const d = await api(`/api/stats/match?id=${encodeURIComponent(id)}${focus ? `&puuid=${encodeURIComponent(focus)}` : ''}`);
    if (req !== mdReq) return;
    mdData = d;
    renderMatch();
  } catch (e) {
    if (req !== mdReq) return;
    $('#md-who').innerHTML = '';
    $('#md-body').innerHTML = `<div class="dash-wait small"><span class="lamp"></span><p class="empty">Partie indisponible.</p><p class="muted">${esc(e.message)}</p></div>`;
  }
}

function renderMatch() {
  const d = mdData;
  if (!d) return;
  const res = d.draw ? 'draw' : d.won ? 'win' : 'loss';
  $('#md-who').innerHTML = `
    <div class="md-map" ${d.map?.image ? `style="background-image:url('${esc(d.map.image)}')"` : ''}><h2>${esc(d.map?.name || '')}</h2></div>
    <div class="md-info">
      <p class="kicker">${esc([QUEUE_FR[d.mode] ?? d.mode, shortDate(d.date), d.minutes ? `${d.minutes} min` : ''].filter(Boolean).join(' · '))}</p>
      <div class="md-score ${res}"><b>${d.score.ally}</b><i>—</i><b>${d.score.enemy}</b><span>${d.draw ? 'Match nul' : d.won ? 'Victoire' : 'Défaite'}</span></div>
    </div>`;
  const tabs = [['board', 'Tableau'], ...(d.hasRounds ? [['rounds', 'Rounds']] : []), ['duels', 'Duels']];
  const pane = mdTab === 'rounds' && d.hasRounds ? mdRounds(d) : mdTab === 'duels' ? mdDuels(d) : mdBoard(d);
  $('#md-body').innerHTML = `
    <div class="segs md-tabs">${tabs.map(([k, l]) => `<button class="seg ${k === mdTab ? 'on' : ''}" data-mdtab="${k}">${l}</button>`).join('')}</div>
    <div class="md-pane">${pane}</div>`;
}

// Tableau des scores
function mdBoard(d) {
  const cols = [['acs', 'ACS'], ['k', 'K'], ['d', 'D'], ['a', 'A'], ['diff', '+/−'], ['adr', 'ADR'], ['hsPct', 'HS'], ['kast', 'KAST'], ['fb', 'FB'], ['fd', 'FD'], ['multi', 'Multi']];
  const top = {};
  for (const [k] of cols) {
    const vals = d.players.map((p) => p[k]).filter((v) => v != null);
    top[k] = ['d', 'fd'].includes(k) ? null : Math.max(...vals);
  }
  const cell = (p, k) => {
    const v = p[k];
    const txt = v == null ? '—' : (k === 'hsPct' || k === 'kast') ? `${Math.round(v)} %` : k === 'diff' ? signed(v) : v;
    const cls = [k, v != null && v === top[k] && v > 0 ? 'top' : '', k === 'diff' ? (v > 0 ? 'up' : v < 0 ? 'down' : '') : ''].join(' ');
    return `<span class="sb-c ${cls}">${txt}</span>`;
  };
  const head = `<div class="sb-row sb-head"><span>Joueur</span>${cols.map(([, l]) => `<span class="sb-c">${l}</span>`).join('')}</div>`;
  const row = (p) => `
    <div class="sb-row ${p.self ? 'me' : ''}">
      <span class="sb-who">${pIcon(p)}<span class="sb-nm">${pName(p)}${p.name ? `<small>#${esc(p.name.split('#')[1] || '')}</small>` : ''}</span>
        ${p.rank ? `<img class="sb-rank" src="${esc(p.rank.icon)}" alt="" title="${esc(titleCase(p.rank.name))}">` : ''}</span>
      ${cols.map(([k]) => cell(p, k)).join('')}
    </div>`;
  const team = (list, label, ally) => `
    <section class="sb-team ${ally ? 'ally' : ''}">
      <h3 class="ms-h"><span>${ally ? '<i class="glow-dot"></i>' : ''}${label}</span><em>${list.length} joueurs</em></h3>
      ${head}${list.map(row).join('')}
    </section>`;
  return team(d.players.filter((p) => p.ally), 'Ton équipe', true) + team(d.players.filter((p) => !p.ally), 'Adversaires', false);
}

// Performances round par round + fil des éliminations du round choisi
function mdRounds(d) {
  const players = [...d.players.filter((p) => p.ally), ...d.players.filter((p) => !p.ally)];
  const byId = Object.fromEntries(d.players.map((p) => [p.puuid, p]));
  const r = d.rounds[mdRound] || d.rounds[0];
  const name = (id) => (byId[id] ? pName(byId[id]) : '?');
  const side = (id) => (byId[id]?.ally ? 'ally' : 'enemy');
  const head = `
    <div class="rg-row rg-head"><span class="rg-who"><small>Kills par round</small></span>
      ${d.rounds.map((x, i) => `<button class="rg-r ${x.ally ? 'win' : 'loss'} ${i === mdRound ? 'on' : ''}" data-round="${i}" title="Round ${x.n} · ${esc(x.result)}${x.ceremony ? ` · ${esc(x.ceremony)}` : ''}">${x.n}</button>`).join('')}
    </div>`;
  const rows = players.map((p) => `
    <div class="rg-row ${p.ally ? 'ally' : 'enemy'} ${p.self ? 'me' : ''}">
      <span class="rg-who">${pIcon(p)}<span>${pName(p)}</span></span>
      ${d.rounds.map((x, i) => {
        const c = x.cells[p.puuid] || {};
        const tip = `Round ${x.n} · ${c.k || 0} kill${(c.k || 0) > 1 ? 's' : ''} · ${c.dmg || 0} dégâts${c.died ? ' · mort' : ' · survivant'}${c.eco != null ? ` · équipement ${c.eco}` : ''}`;
        return `<span class="rg-c k${Math.min(c.k || 0, 5)} ${c.died ? 'dead' : ''} ${i === mdRound ? 'on' : ''}" data-round="${i}" title="${tip}">${c.k || ''}</span>`;
      }).join('')}
    </div>`).join('');
  const info = [
    esc(r.result), r.ceremony ? `<b class="glow">${esc(r.ceremony)}</b>` : '', r.site ? `Site ${esc(r.site)}` : '',
    r.planter ? `Plant : ${name(r.planter)}` : '', r.defuser ? `Désamorçage : ${name(r.defuser)}` : '',
  ].filter(Boolean).join('<i>·</i>');
  const feed = r.feed.map((k) => `
    <li class="${k.teamkill ? 'tk' : ''}">
      <span class="kf-t">${clock(k.t * 1000)}</span>
      <b class="${side(k.killer)}">${name(k.killer)}</b>
      <span class="kf-w">${esc(k.weapon || '→')}</span>
      <b class="${side(k.victim)}">${name(k.victim)}</b>
    </li>`).join('');
  const dmg = players.map((p) => ({ p, c: r.cells[p.puuid] || {} })).filter((x) => x.c.dmg || x.c.k)
    .sort((a, b) => b.c.dmg - a.c.dmg).slice(0, 6);
  return `
    <div class="rg" style="--rounds:${d.rounds.length}">${head}${rows}</div>
    <div class="rd">
      <div class="rd-h"><b class="${r.ally ? 'win' : 'loss'}">Round ${r.n} · ${r.ally ? 'gagné' : 'perdu'}</b><span>${info}</span></div>
      <div class="rd-cols">
        <ol class="kf">${feed || '<li class="play-note">Aucune élimination.</li>'}</ol>
        <div class="rd-dmg">
          <h4 class="ms-h">Dégâts du round</h4>
          ${dmg.map(({ p, c }) => `<div class="rd-d ${p.ally ? 'ally' : 'enemy'}"><span class="rg-who">${pIcon(p)}<span>${pName(p)}</span></span><b>${c.dmg}</b><small>${c.k ? `${c.k} K` : ''}</small></div>`).join('') || '<p class="play-note">—</p>'}
        </div>
      </div>
    </div>`;
}

// Duels : éliminations / morts de chaque allié contre chaque adversaire
function mdDuels(d) {
  const byId = Object.fromEntries(d.players.map((p) => [p.puuid, p]));
  const A = d.duels.allies.map((id) => byId[id]);
  const E = d.duels.enemies.map((id) => byId[id]);
  if (!A.length || !E.length) return '<p class="empty">Pas de duels dans ce mode.</p>';
  const head = `<div class="dm-row dm-head"><span></span>${E.map((p) => `<span class="dm-who">${pIcon(p)}<small>${pName(p)}</small></span>`).join('')}<span class="dm-tot">Bilan</span></div>`;
  const rows = A.map((a, i) => {
    let K = 0, D = 0;
    const cells = d.duels.matrix[i].map((c, j) => {
      K += c.kills; D += c.deaths;
      const cls = c.kills > c.deaths ? 'win' : c.kills < c.deaths ? 'loss' : 'even';
      return `<span class="dm-c ${cls}" title="${pName(a)} a éliminé ${pName(E[j])} ${c.kills} fois, et s'est fait éliminer ${c.deaths} fois"><b>${c.kills}</b><i>–</i>${c.deaths}</span>`;
    }).join('');
    return `<div class="dm-row ${a.self ? 'me' : ''}"><span class="rg-who">${pIcon(a)}<span>${pName(a)}</span></span>${cells}<span class="dm-tot ${K > D ? 'win' : K < D ? 'loss' : ''}">${signed(K - D)}</span></div>`;
  }).join('');
  // tes rivaux : ta proie et ta bête noire
  let rivals = '';
  const mi = A.findIndex((p) => p.self);
  if (mi >= 0) {
    const mine = d.duels.matrix[mi].map((c, j) => ({ ...c, p: E[j] }));
    const prey = [...mine].sort((x, y) => (y.kills - y.deaths) - (x.kills - x.deaths))[0];
    const nemesis = [...mine].sort((x, y) => (y.deaths - y.kills) - (x.deaths - x.kills))[0];
    const card = (label, x, txt) => `<div class="cool"><span>${label}</span><b>${pName(x.p)}</b><small>${txt}</small></div>`;
    rivals = `<div class="ms-cool dm-rivals">
      ${prey && prey.kills > prey.deaths ? card('Ta proie', prey, `${prey.kills} éliminations pour ${prey.deaths} morts`) : ''}
      ${nemesis && nemesis.deaths > nemesis.kills ? card('Ta bête noire', nemesis, `${nemesis.deaths} morts pour ${nemesis.kills} éliminations`) : ''}
    </div>`;
  }
  return `<p class="play-note dm-help">Chaque case : <b>éliminations</b> – morts de l'allié (ligne) face à l'adversaire (colonne).</p>
    <div class="dm" style="--cols:${E.length}">${head}${rows}</div>${rivals}`;
}

document.addEventListener('click', (e) => {
  const m = e.target.closest('[data-match]');
  if (m && !e.target.closest('#match-dialog')) openMatch(m.dataset.match, m.dataset.focus);
});
document.addEventListener('keydown', (e) => {
  const m = e.target.closest?.('[data-match]');
  if (m && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openMatch(m.dataset.match, m.dataset.focus); }
});
$('#md-body').addEventListener('click', (e) => {
  const t = e.target.closest('[data-mdtab]');
  if (t) { mdTab = t.dataset.mdtab; renderMatch(); return; }
  const r = e.target.closest('[data-round]');
  if (r) { mdRound = +r.dataset.round; renderMatch(); }
});
$('#md-close').onclick = () => $('#match-dialog').close();
$('#match-dialog').onclick = (e) => { if (e.target.id === 'match-dialog') e.target.close(); };
