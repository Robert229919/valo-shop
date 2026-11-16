// Mise à jour de la version portable (electron-updater ne gère pas le portable).
// On interroge l'API publique des releases GitHub, on télécharge le nouvel exe à côté de l'ancien,
// puis un petit script remplace l'ancien fichier une fois l'appli fermée et relance la nouvelle version.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const REPO = 'Robert229919/valo-shop';
const ASSET = 'ValoShop-portable.exe';
const UA = 'valo-shop-updater'; // nom générique, aucune donnée personnelle

// Surcharge de l'API possible uniquement vers cette machine (tests)
function localOverride() {
  const o = process.env.VALO_UPDATE_API;
  return o && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(o) ? o : null;
}
const apiUrl = () => localOverride() || `https://api.github.com/repos/${REPO}/releases/latest`;
const downloadAllowed = (url) => String(url).startsWith(`https://github.com/${REPO}/releases/download/`)
  || (!!localOverride() && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(String(url)));

// true si `remote` est strictement plus récente que `local` (x.y.z, préfixe "v" ignoré)
export function isNewer(remote, local) {
  const n = (v) => String(v).replace(/^v/i, '').split('-')[0].split('.').map((x) => parseInt(x, 10) || 0);
  const a = n(remote), b = n(local);
  for (let i = 0; i < Math.max(a.length, b.length, 3); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

// Renvoie { version, url, size, digest, page } si une version plus récente existe, sinon null
export async function checkForPortableUpdate(currentVersion) {
  const res = await fetch(apiUrl(), { headers: { Accept: 'application/vnd.github+json', 'User-Agent': UA } });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  const rel = await res.json();
  if (rel.draft || rel.prerelease) return null;
  const version = String(rel.tag_name || '').replace(/^v/i, '');
  if (!isNewer(version, currentVersion)) return null;
  const asset = (rel.assets || []).find((a) => a.name === ASSET);
  if (!asset || !downloadAllowed(asset.browser_download_url)) return null;
  return {
    version, url: asset.browser_download_url, size: asset.size || 0, digest: asset.digest || null,
    page: rel.html_url || `https://github.com/${REPO}/releases/latest`,
  };
}

// Télécharge le nouvel exe dans `dir` (taille et somme de contrôle vérifiées). onProgress(0..1)
export async function downloadUpdate(info, dir, onProgress = () => {}) {
  if (!downloadAllowed(info.url)) throw new Error('Adresse de téléchargement inattendue');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${ASSET}.update`);
  const res = await fetch(info.url, { headers: { 'User-Agent': UA } });
  if (!res.ok || !res.body) throw new Error(`Téléchargement impossible (${res.status})`);
  const total = Number(res.headers.get('content-length')) || info.size || 0;
  const hash = crypto.createHash('sha256');
  let got = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      got += chunk.length; hash.update(chunk);
      if (total) onProgress(Math.min(1, got / total));
      cb(null, chunk);
    },
  });
  const drop = () => fs.rmSync(dest, { force: true });
  try {
    await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(dest));
  } catch (e) { drop(); throw e; }
  if (info.size && got !== info.size) { drop(); throw new Error('Fichier incomplet'); }
  const want = /^sha256:([0-9a-f]{64})$/i.exec(info.digest || '')?.[1];
  if (want && hash.digest('hex') !== want.toLowerCase()) { drop(); throw new Error('Somme de contrôle invalide'); }
  return dest;
}

// Remplace `targetExe` par `newFile` dès que l'appli est fermée, puis relance la nouvelle version.
// À appeler juste avant de quitter l'appli.
export function applyUpdate(newFile, targetExe) {
  const esc = (p) => String(p).replace(/%/g, '%%');
  const script = path.join(os.tmpdir(), `valoshop-update-${process.pid}.cmd`);
  fs.writeFileSync(script, [
    '@echo off',
    'chcp 65001 >nul',
    `set "NEW=${esc(newFile)}"`,
    `set "OLD=${esc(targetExe)}"`,
    'set /a n=0',
    ':retry',
    // le fichier est verrouillé tant que l'appli tourne : on réessaie pendant ~90 s
    'move /Y "%NEW%" "%OLD%" >nul 2>&1 && goto done',
    'set /a n+=1',
    'if %n% GEQ 90 goto end',
    'ping -n 2 127.0.0.1 >nul',
    'goto retry',
    ':done',
    'start "" "%OLD%"',
    ':end',
    '(goto) 2>nul & del "%~f0"',
  ].join('\r\n'), 'utf8');
  spawn('cmd.exe', ['/c', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
