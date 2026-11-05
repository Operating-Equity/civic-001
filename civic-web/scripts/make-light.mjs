// Writes public/assets/light.avif: the light under the text box's letters as they are typed (js/app.js, wireGlow).
// One colour at the full signal of the HLG curve (BT.2100), BT.2020 primaries, 10-bit: on a screen that shows light
// brighter than white it is as bright as the screen allows; on one that does not, it is the page's white. A round pool,
// opaque at its centre, its transparency fading to nothing at its edge along 1 - smoothstep. Made with ffmpeg (libaom);
// not run in CI. Usage: node scripts/make-light.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public', 'assets', 'light.avif');
const SIDE = 800;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'light-'));
try {
  // The colour: limited range, full signal (940) on the luma plane, neutral (512) on both chroma planes.
  const yuv = Buffer.alloc(SIDE * SIDE * 3);
  for (let i = 0; i < SIDE * SIDE; i++) yuv.writeUInt16LE(940, i * 2);
  for (let i = SIDE * SIDE; i < SIDE * SIDE * 1.5; i++) yuv.writeUInt16LE(512, i * 2);
  // The transparency: full range, 1 at the centre, 0 at the edge and beyond.
  const alpha = Buffer.alloc(SIDE * SIDE * 2);
  const c = (SIDE - 1) / 2, r = SIDE / 2;
  for (let y = 0; y < SIDE; y++) for (let x = 0; x < SIDE; x++) {
    const t = Math.min(1, Math.hypot(x - c, y - c) / r);
    alpha.writeUInt16LE(Math.round((1 - t * t * (3 - 2 * t)) * 1023), (y * SIDE + x) * 2);
  }
  fs.writeFileSync(path.join(tmp, 'colour.yuv'), yuv);
  fs.writeFileSync(path.join(tmp, 'alpha.raw'), alpha);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'yuv420p10le', '-s', `${SIDE}x${SIDE}`, '-i', path.join(tmp, 'colour.yuv'),
    '-f', 'rawvideo', '-pix_fmt', 'gray10le', '-s', `${SIDE}x${SIDE}`, '-i', path.join(tmp, 'alpha.raw'),
    '-map', '0', '-map', '1', '-c:v', 'libaom-av1', '-still-picture', '1', '-crf', '12', '-cpu-used', '4',
    '-color_primaries:v:0', 'bt2020', '-color_trc:v:0', 'arib-std-b67', '-colorspace:v:0', 'bt2020nc', '-color_range:v:0', 'tv',
    '-color_range:v:1', 'pc', OUT]);
  console.log(`${OUT}: ${fs.statSync(OUT).size} bytes`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
