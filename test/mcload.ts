// machine-code loader using the KERNAL I/O calls (OPEN/CHKIN/CHRIN) instead of LOAD
import { makeC64, makeOrigC64 } from './util';
import { parseD64 } from '../src/media';
import { readFileSync } from 'fs';
const img = new Uint8Array(readFileSync(process.argv[2]));
for (const [label, mk] of [['ROM originali', makeOrigC64], ['Open ROMs', makeC64]] as const) {
  if (label === 'ROM originali' && !process.env.ORIG) continue;
  const c = mk();
  c.mountDisk(parseD64(img), img);
  for (let i = 0; i < 150; i++) c.runFrame();
  const code = [0xa9, 0x05, 0xa2, 0x40, 0xa0, 0xc0, 0x20, 0xbd, 0xff, 0xa9, 0x02, 0xa2, 0x08, 0xa0, 0x02, 0x20, 0xba, 0xff,
    0x20, 0xc0, 0xff, 0xa2, 0x02, 0x20, 0xc6, 0xff, 0xa0, 0x00, 0x20, 0xcf, 0xff, 0x99, 0x00, 0xc1, 0xc8, 0xc0, 0x0f,
    0xd0, 0xf5, 0x20, 0xcc, 0xff, 0xa9, 0x02, 0x20, 0xc3, 0xff, 0x60];
  c.ram.set(code, 0xc000);
  c.ram.set([0x48, 0x45, 0x4c, 0x4c, 0x4f], 0xc040);
  c.ram.fill(0xee, 0xc100, 0xc110);
  c.typeText('SYS49152\n');
  for (let i = 0; i < 120; i++) c.runFrame();
  const got = Array.from(c.ram.subarray(0xc100, 0xc10f), (v) => v.toString(16).padStart(2, '0')).join(' ');
  console.log(label.padEnd(14), got, got === '01 08 0f 08 0a 00 99 22 48 49 21 22 00 00 00' ? 'OK' : 'DIVERSO');
}
