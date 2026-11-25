// D71 (1571) and D81 (1581) images through the virtual drive
import { makeOrigC64, screenText } from './util';
import { parseD64 } from '../src/media';
import { blankDisk, geometryFor } from '../src/geometry';
import { writeFile, scratch } from '../src/d64write';

for (const kind of ['d71', 'd81'] as const) {
  const img = blankDisk(kind, `PROVA ${kind}`, '42');
  const d0 = parseD64(img);
  console.log(`${kind.toUpperCase()}: ${img.length} byte, titolo "${d0.title.trim()}", id ${d0.id}, blocchi liberi ${d0.freeBlocks} (attesi ${kind === 'd71' ? 1328 : 3160})`);
  // a big file crosses to the second side of a D71 / to tracks far from 40 on a D81
  const big = new Uint8Array(254 * 900).map((_, i) => i & 255);
  const code = writeFile(img, Uint8Array.from('GRANDE', (c) => c.charCodeAt(0)), 'SEQ', big);
  const d1 = parseD64(img);
  const f = d1.files.find((x) => x.name === 'GRANDE')!;
  const same = f.data!.length === big.length && f.data!.every((v, i) => v === big[i]);
  // which tracks did it use?
  const g = geometryFor(img);
  const tracks = new Set<number>();
  { const dirOff = g.offset(g.dirTrack, g.firstDirSector); let t = img[dirOff + 2 + 1], s = img[dirOff + 2 + 2];
    while (t) { tracks.add(t); const o = g.offset(t, s); t = img[o]; s = img[o + 1]; } }
  const tl = [...tracks].sort((a, b) => a - b);
  console.log(`  file da 900 blocchi: esito ${code}, riletto identico ${same}, tracce ${tl[0]}…${tl[tl.length - 1]} (${tl.length} tracce), liberi ${d1.freeBlocks}`);
  scratch(img, Uint8Array.from('GRANDE', (c) => c.charCodeAt(0)));
  console.log(`  dopo la cancellazione: liberi ${parseD64(img).freeBlocks}`);

  // through the C64: SAVE, LOAD"$", LOAD and RUN
  const c = makeOrigC64();
  c.mountDisk(parseD64(img), img);
  for (let i = 0; i < 150; i++) c.runFrame();
  c.typeText(`NEW\n10 PRINT"CIAO DAL ${kind.toUpperCase()}"\nSAVE"SALUTO",8\nNEW\nLOAD"$",8\nLIST\n`);
  for (let i = 0; i < 300; i++) c.runFrame();
  console.log('  ' + screenText(c).split('\n').filter((l) => l.trim()).slice(-5, -1).join(' / '));
  c.typeText('LOAD"SALUTO",8\nRUN\n');
  for (let i = 0; i < 200; i++) c.runFrame();
  console.log('  ' + screenText(c).split('\n').filter((l) => l.trim()).slice(-2).join(' / '));
}
