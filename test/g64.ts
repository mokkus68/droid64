// G64 images in the emulated 1541: byte aligned, bit shifted (sync not on byte boundaries), writing
import { makeOrigC64, screenText } from './util';
import { parseD64 } from '../src/media';
import { d64ToGcrDisk, toG64, parseG64, gcrDiskToD64, GcrDisk } from '../src/gcr';
import { readFileSync } from 'fs';

// a consistent D64 (formatted by the emulator) with the same two files as the test disk
import { blankD64, writeFile } from '../src/d64write';
const src = parseD64(new Uint8Array(readFileSync(process.argv[2])));
const d64 = blankD64('G64 TEST', 'GT');
for (const f of src.files) if (f.data) writeFile(d64, f.rawName, 'PRG', f.data);
const rom = new Uint8Array(readFileSync(process.env.DRIVEROM!));

/** Rotate every track's bit stream by n bits, so sync marks fall in the middle of bytes. */
function shiftBits(disk: GcrDisk, n: number): GcrDisk {
  const tracks = disk.tracks.map((t, i) => {
    if (!t) return t;
    const bits = disk.bits[i], out = new Uint8Array(t.length);
    for (let k = 0; k < bits; k++) {
      const src = (k + n) % bits;
      if ((t[src >> 3] >> (7 - (src & 7))) & 1) out[k >> 3] |= 0x80 >> (k & 7);
    }
    return out;
  });
  return { tracks, bits: disk.bits.slice() };
}

for (const [label, g64] of [['G64 allineato', toG64(d64ToGcrDisk(d64))], ['G64 spostato di 3 bit', toG64(shiftBits(d64ToGcrDisk(d64), 3))]] as const) {
  const listing = parseD64(gcrDiskToD64(parseG64(g64)));
  const c = makeOrigC64();
  c.attachDrive(rom);
  c.mountDisk(listing, g64);
  for (let i = 0; i < 150; i++) c.runFrame();
  const run = (t: string, f: number) => { c.typeText(t); for (let i = 0; i < f; i++) c.runFrame(); };
  run('LOAD"$",8\n', 400); run('LIST\n', 30);
  const dir = screenText(c).includes('"HELLO"');
  run('LOAD"HELLO",8\n', 400); run('RUN\n', 30);
  const ok = screenText(c).includes('HI!');
  console.log(`${label}: ${g64.length} byte, elenco decodificato ${listing.files.map((f) => f.name).join(',')} | directory dal 1541 ${dir} | LOAD+RUN ${ok}`);
  if (label === 'G64 spostato di 3 bit') {
    let changes = 0;
    c.onDiskChanged = () => changes++;
    run('NEW\n10 PRINT"SCRITTO SU G64"\nSAVE"NUOVO",8\n', 500);
    for (let i = 0; i < 400; i++) c.runFrame();
    const out = c.currentImage(8)!;
    const after = parseD64(gcrDiskToD64(parseG64(out)));
    run('NEW\nLOAD"NUOVO",8\n', 400); run('RUN\n', 30);
    console.log(`  SAVE su G64: aggiornamenti ${changes}, file dopo l'esportazione ${after.files.map((f) => f.name).join(',')} | ricaricato: ${screenText(c).includes('SCRITTO SU G64')}`);
  }
}
