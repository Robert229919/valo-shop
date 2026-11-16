// App de bureau : lance le serveur local + une fenêtre, et gère la connexion Riot
// comme les applis mobiles (VALpaw…) : la vraie page Riot s'ouvre dans une fenêtre
// intégrée, ses cookies ("Rester connecté") sont conservés dans une partition
// persistante, et on les réutilise en arrière-plan pour obtenir de nouveaux tokens.
import { app, BrowserWindow, session, shell, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

// Même dossier de données (cookies Riot) en dev et dans l'.exe : pas besoin de se reconnecter.
app.setPath('userData', path.join(app.getPath('appData'), 'valo-shop-viewer'));

const { ready } = await import('../server.js');
const { setReauthProvider, setAccountStore, initAccounts, LOGIN_URL } = await import('../riot.js');

let mainWindow = null;

// Liste des comptes : métadonnées seulement (id, puuid, nom, région, partition), jamais de token.
const ACCOUNTS_FILE = path.join(app.getPath('userData'), 'accounts.json');
const accountStore = {
  load() {
    try { return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); } catch { return null; }
  },
  save(data) {
    const tmp = `${ACCOUNTS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, ACCOUNTS_FILE); // écriture atomique
  },
};

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { mainWindow?.show(); mainWindow?.focus(); });

const chromeUA = () => app.userAgentFallback.replace(/ Electron\/\S+/, '').replace(/ valo-shop-viewer\/\S+/, '');

// Renvoie l'URL playvalorant.com#access_token=... ; silencieux si les cookies de la partition
// (une par compte) sont valides.
function getRiotTokenUrl({ interactive, partition }) {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 500, height: 780, show: false, title: 'Connexion Riot', autoHideMenuBar: true,
      parent: interactive ? mainWindow ?? undefined : undefined,
      webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.webContents.setUserAgent(chromeUA());

    let done = false;
    let showTimer = null;
    const finish = (err, url) => {
      if (done) return;
      done = true;
      clearTimeout(timeout); clearTimeout(showTimer);
      if (!win.isDestroyed()) win.destroy();
      err ? reject(err) : resolve(url);
    };
    const check = (event, url) => {
      if (url.startsWith('https://playvalorant.com') && url.includes('access_token=')) {
        event?.preventDefault();
        finish(null, url);
      }
    };
    win.webContents.on('will-redirect', check);
    win.webContents.on('will-navigate', check);
    win.webContents.on('did-navigate', (_e, url) => check(null, url));
    win.webContents.on('did-navigate-in-page', (_e, url) => check(null, url));
    win.webContents.on('did-finish-load', () => {
      // Si on reste sur une page Riot, c'est que les cookies ne suffisent pas : formulaire de connexion.
      clearTimeout(showTimer);
      showTimer = setTimeout(() => {
        if (done) return;
        if (interactive) { win.show(); win.focus(); }
        else finish(new Error('cookies Riot expirés'));
      }, 1500);
    });
    // Liens externes (mot de passe oublié, etc.) dans le navigateur
    win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
    win.on('closed', () => finish(new Error('Connexion annulée')));
    const timeout = setTimeout(() => finish(new Error('Délai de connexion Riot dépassé')), interactive ? 10 * 60_000 : 30_000);
    win.loadURL(LOGIN_URL).catch(() => { /* navigation interrompue volontairement */ });
  });
}

// Efface cookies et données d'une partition de compte
async function clearPartition(partition) {
  const ses = session.fromPartition(partition);
  await ses.clearStorageData();
  await ses.clearCache();
}

app.whenReady().then(async () => {
  let url;
  try {
    url = await ready;
  } catch (e) {
    dialog.showErrorBox('Valo Shop', `Impossible de démarrer le serveur local (${e.code || e.message}).\nLe port est peut-être déjà utilisé par "npm start".`);
    return app.quit();
  }
  setReauthProvider(getRiotTokenUrl, clearPartition);
  setAccountStore(accountStore);

  // Charge les comptes (migre l'ancien `persist:riot` au 1er lancement) et restaure le compte actif
  try { await initAccounts(); } catch (e) { console.warn('[accounts]', e.message); }

  mainWindow = new BrowserWindow({
    width: BASE_VIEW.w, height: BASE_VIEW.h, useContentSize: true, minWidth: 900, minHeight: 620,
    backgroundColor: '#15110e', title: 'Valo Shop', autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // Zoom proportionnel : l'interface garde la même mise en page quelle que soit la taille
  // de la fenêtre (plein écran = même rendu, juste plus grand).
  const fitZoom = () => {
    if (mainWindow.isDestroyed()) return;
    const [w, h] = mainWindow.getContentSize();
    mainWindow.webContents.setZoomFactor(Math.max(0.6, Math.min(w / BASE_VIEW.w, h / BASE_VIEW.h)));
  };
  for (const ev of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) mainWindow.on(ev, fitZoom);
  mainWindow.webContents.on('did-finish-load', fitZoom);
  mainWindow.webContents.setWindowOpenHandler(({ url: u }) => { shell.openExternal(u); return { action: 'deny' }; });
  mainWindow.on('closed', () => app.quit());
  mainWindow.loadURL(url);
  setupAutoUpdate();
});

// Version portable : au lancement (puis toutes les 6 h) on vérifie la dernière release GitHub et on propose
// de la télécharger ; l'exe portable est alors remplacé et l'appli se relance toute seule.
async function setupPortableUpdate() {
  const portableFile = process.env.PORTABLE_EXECUTABLE_FILE;
  let mod;
  try { mod = await import('./portable-update.js'); } catch (e) { console.warn('[update]', e.message); return; }
  let busy = false;
  let notified = null; // une seule proposition par version et par session
  const check = async () => {
    if (busy) return;
    let info;
    try { info = await mod.checkForPortableUpdate(app.getVersion()); } catch (e) { console.warn('[update]', e.message); return; }
    if (!info || notified === info.version || !mainWindow || mainWindow.isDestroyed()) return;
    notified = info.version;
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Mise à jour disponible',
      message: `Valo Shop ${info.version} est disponible (tu as la ${app.getVersion()}).`,
      detail: "Télécharger la nouvelle version maintenant ? L'appli se fermera puis se relancera toute seule : ton fichier portable est remplacé par la nouvelle version.",
      buttons: ['Mettre à jour', 'Plus tard'],
      defaultId: 0, cancelId: 1,
    });
    if (response !== 0) return;
    busy = true;
    try {
      // à côté de l'exe portable si le dossier est modifiable, sinon dans le dossier temporaire
      let dir = path.dirname(portableFile);
      try { fs.accessSync(dir, fs.constants.W_OK); } catch { dir = app.getPath('temp'); }
      const file = await mod.downloadUpdate(info, dir, (p) => { if (!mainWindow.isDestroyed()) mainWindow.setProgressBar(p); });
      if (!mainWindow.isDestroyed()) mainWindow.setProgressBar(-1);
      mod.applyUpdate(file, portableFile);
      app.quit();
    } catch (e) {
      busy = false;
      if (!mainWindow.isDestroyed()) mainWindow.setProgressBar(-1);
      const r = await dialog.showMessageBox(mainWindow, {
        type: 'error', title: 'Mise à jour impossible',
        message: 'Le téléchargement de la mise à jour a échoué.', detail: String(e.message || e),
        buttons: ['Ouvrir la page de téléchargement', 'Fermer'], defaultId: 0, cancelId: 1,
      });
      if (r.response === 0) shell.openExternal(info.page);
    }
  };
  setTimeout(check, 8000);
  setInterval(check, 6 * 3600_000);
}

// Mises à jour automatiques via les releases GitHub (version installée : electron-updater ;
// version portable : voir setupPortableUpdate ; rien en dev).
async function setupAutoUpdate() {
  if (!app.isPackaged) return;
  if (process.env.PORTABLE_EXECUTABLE_FILE) return setupPortableUpdate();
  let autoUpdater;
  try {
    const mod = await import('electron-updater');
    autoUpdater = mod.autoUpdater || mod.default?.autoUpdater;
  } catch (e) {
    console.warn('[update]', e.message); return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', (e) => console.warn('[update]', e?.message || e));
  autoUpdater.on('update-downloaded', async (info) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Mise à jour disponible',
      message: `Valo Shop ${info.version} est prête à être installée.`,
      detail: "Redémarrer maintenant pour l'appliquer ? Sinon, elle s'installera à la prochaine fermeture de l'appli.",
      buttons: ['Redémarrer', 'Plus tard'],
      defaultId: 0, cancelId: 1,
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });
  const check = () => autoUpdater.checkForUpdates().catch((e) => console.warn('[update]', e.message));
  check();
  setInterval(check, 6 * 3600_000); // puis toutes les 6 h
}

// Taille de référence de l'interface (celle validée sur capture), en pixels CSS
const BASE_VIEW = { w: 1280, h: 860 };

// Ne pas quitter quand seule la fenêtre de connexion Riot (cachée) se ferme :
// on quitte uniquement quand la fenêtre principale est fermée.
app.on('window-all-closed', () => { if (mainWindow?.isDestroyed()) app.quit(); });
