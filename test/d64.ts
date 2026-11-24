import { makeC64, makeOrigC64, screenText } from './util';
import { parseD64 } from '../src/media';
// build a minimal D64 with two files
const img = new Uint8Array(174848);
const SEC = (t: number) => (t <= 17 ? 21 : t <= 24 ? 19 : t <= 30 ? 18 : 17);
const off = (t: number, s: number) => { let o = 0; for (let i = 1; i < t; i++) o += SEC(i) * 256; return o + s * 256; };
const bam = off(18, 0);
img[bam] = 18; img[bam + 1] = 1; img[bam + 2] = 0x41;
for (let t = 1; t <= 35; t++) img[bam + t * 4] = SEC(t);
const title = 'TEST DISK'; for (let i = 0; i < 16; i++) img[bam + 0x90 + i] = i < title.length ? title.charCodeAt(i) : 0xa0;
img.set([0x41, 0x42, 0xa0, 0x32, 0x41], bam + 0xa2);
const files = [
  { name: 'HELLO', data: [0x01, 0x08, 0x0f, 0x08, 0x0a, 0x00, 0x99, 0x22, 0x48, 0x49, 0x21, 0x22, 0x00, 0x00, 0x00] }, // 10 PRINT"HI!"
  { name: 'GAME', data: [0x00, 0xc0, 0xee, 0x20, 0xd0, 0x60] },
];
const dir = off(18, 1);
files.forEach((f, i) => {
  const e = dir + i * 32;
  img[e + 2] = 0x82; img[e + 3] = 17; img[e + 4] = i;
  for (let k = 0; k < 16; k++) img[e + 5 + k] = k < f.name.length ? f.name.charCodeAt(k) : 0xa0;
  img[e + 30] = 1;
  const so = off(17, i);
  img[so] = 0; img[so + 1] = f.data.length + 1;
  img.set(f.data, so + 2);
});
const disk = parseD64(img);
console.log(disk.title, disk.files.map((f) => `${f.name}:${f.data?.length}`));
for (const mk of [makeOrigC64, makeC64]) {
  if (mk === makeOrigC64 && !process.env.ORIG) continue;
  const c = mk();
  c.mountDisk(disk);
  c.onDiskLoad = (n, ok) => console.log('  trap load', n, ok);
  for (let i = 0; i < 150; i++) c.runFrame();
  c.typeText('LOAD"$",8\nLIST\nLOAD"HEL*",8\nRUN\nLOAD"GAME",8,1\nSYS49152\nPRINT PEEK(53280)\n');
  for (let i = 0; i < 400; i++) c.runFrame();
  console.log(screenText(c).split('\n').filter((l) => l.trim()).slice(-16).join('\n'));
}
