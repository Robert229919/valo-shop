// Génère build/icon.png (512x512) : la "lampe" orange avec son trou, sans dépendance.
import fs from 'node:fs';
import zlib from 'node:zlib';

const S = 512;
const px = Buffer.alloc(S * S * 4);
const c = S / 2, R = S * 0.46, hole = S * 0.075, holeY = c - R * 0.55;
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
    const dh = Math.hypot(x + 0.5 - c, y + 0.5 - holeY);
    let a = Math.min(1, Math.max(0, R - d + 0.5)) * Math.min(1, Math.max(0, dh - hole + 0.5));
    // dégradé orange (plus clair en haut à gauche)
    const t = Math.min(1, Math.hypot(x - c * 0.85, y - c * 0.75) / R);
    const r = 255, g = Math.round(122 - 50 * t), b = Math.round(61 - 45 * t);
    const i = (y * S + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = Math.round(a * 255);
  }
}
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let k = n;
  for (let j = 0; j < 8; j++) k = k & 1 ? 0xedb88320 ^ (k >>> 1) : k >>> 1;
  return k >>> 0;
});
const crc = (buf) => { let k = ~0; for (const v of buf) k = crcTable[(k ^ v) & 0xff] ^ (k >>> 8); return ~k >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, cr]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
fs.writeFileSync(new URL('./icon.png', import.meta.url), Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
]));
console.log('build/icon.png généré');
