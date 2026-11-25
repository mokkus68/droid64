// Snapshot determinism: save in the middle of activity, restore into a fresh machine, run both,
// and compare everything.
import { makeOrigC64, screenText } from './util';
import { parseD64 } from '../src/media';
import { blankD64, writeFile } from '../src/d64write';
import { readFileSync } from 'fs';

const rom = new Uint8Array(readFileSync(process.env.DRIVEROM!));
const src = parseD64(new Uint8Array(readFileSync(process.argv[2])));
const disk = blankD64('SNAP', 'SN');
for (const f of src.files) if (f.data) writeFile(disk, f.rawName, 'PRG', f.data);
// a bigger file so the drive is busy for a while
const big = new Uint8Array(2 + 9000).map((_, i) => (i < 2 ? [0x00, 0x20][i] : (i * 7) & 255));
writeFile(disk, Uint8Array.from('GRANDE', (c) => c.charCodeAt(0)), 'PRG', big);

function machine(img: Uint8Array) {
  const c = makeOrigC64();
  c.setReu(512);
  c.attachDrive(rom);
  c.mountDisk(parseD64(img), img);
  return c;
}

for (const real of [true, false]) {
  const imgA = disk.slice();
  const a = machine(imgA);
  if (!real) a.attachDrive(null);
  for (let i = 0; i < 150; i++) a.runFrame();
  // a sound, the REU in use, and a load in progress
  a.typeText('POKE54296,15:POKE54277,9:POKE54273,30:POKE54276,17\nPOKE57090,0:POKE57091,4:POKE57095,232:POKE57096,3:POKE57089,176\nLOAD"GRANDE",8,1\n');
  for (let i = 0; i < (real ? 220 : 60); i++) a.runFrame();
  const st = JSON.parse(JSON.stringify(a.saveState())); // through JSON, like a stored snapshot
  const imgB = a.currentImage(8)!.slice();
  const size = JSON.stringify(st).length;

  const b = machine(imgB);
  if (!real) b.attachDrive(null);
  b.mountDisk(parseD64(imgB), imgB);
  b.loadState(st);

  for (let i = 0; i < (real ? 1600 : 200); i++) { a.runFrame(); b.runFrame(); }
  const same = (x: ArrayLike<number>, y: ArrayLike<number>) => x.length === y.length && Array.from(x).every((v, i) => v === y[i]);
  const checks: [string, boolean][] = [
    ['RAM', same(a.ram, b.ram)],
    ['color RAM', same(a.colorRam, b.colorRam)],
    ['CPU', a.cpu.pc === b.cpu.pc && a.cpu.a === b.cpu.a && a.cpu.s === b.cpu.s && a.cpu.cycles === b.cpu.cycles],
    ['VIC', same(a.vic.regs, b.vic.regs) && same(a.vic.frameBuffer, b.vic.frameBuffer)],
    ['SID', same(a.sid.regs, b.sid.regs)],
    ['CIA', a.cia1.ta === b.cia1.ta && a.cia2.tb === b.cia2.tb],
    ['REU', same(a.reu!.ram, b.reu!.ram)],
  ];
  if (real) checks.push(['1541', same(a.drive!.ram, b.drive!.ram) && a.drive!.cpu.pc === b.drive!.cpu.pc && a.drive!.halftrack === b.drive!.halftrack]);
  const loaded = a.ram[0x2000 + 8999 - 1] === big[2 + 8999 - 1] && b.ram[0x2000 + 8999 - 1] === big[2 + 8999 - 1];
  console.log(`${real ? '1541 emulato' : 'drive virtuale'}: snapshot ${(size / 1024).toFixed(0)} KB | ` +
    checks.map(([n, ok]) => `${n} ${ok ? 'uguale' : 'DIVERSO'}`).join(', ') + ` | file caricato in entrambe ${loaded} | ${screenText(b).includes('READY') ? 'READY' : ''}`);
}
