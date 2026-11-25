import { makeC64, makeOrigC64 } from './util';
import { Cartridge } from '../src/cartridge';
import { writeFileSync } from 'fs';

import { buildCrt } from './crtbuild';
export { buildCrt };
const page8k = (code: number[], at = 0) => { const d = new Uint8Array(8192).fill(0xea); d.set(code, at); return d; };
const CBM80 = [0x09, 0x80, 0x09, 0x80, 0xc3, 0xc2, 0xcd, 0x38, 0x30]; // vectors → $8009, "CBM80"

type Check = (c: ReturnType<typeof makeC64>) => string;
const tests: [string, Uint8Array, Check][] = [];
// 1) normal 8K: border = 2
tests.push(['normal 8K', buildCrt(0, 0, 1, 'TEST 8K', [{ bank: 0, load: 0x8000, data: page8k([...CBM80, 0xa9, 0x02, 0x8d, 0x20, 0xd0, 0x4c, 0x0e, 0x80]) }]),
  (c) => `border=${c.vic.regs[0x20] & 15} (atteso 2)`]);
// 2) Ocean: bank 0 switches to bank 1; bank 1 continues at $800E and sets border = 5
const b0 = page8k([...CBM80, 0xa9, 0x01, 0x8d, 0x00, 0xde]);
const b1 = page8k([0xa9, 0x05, 0x8d, 0x20, 0xd0, 0x4c, 0x13, 0x80], 0x0e);
tests.push(['Ocean bank switch', buildCrt(5, 0, 1, 'TEST OCEAN', [{ bank: 0, load: 0x8000, data: b0 }, { bank: 1, load: 0x8000, data: b1 }]),
  (c) => `border=${c.vic.regs[0x20] & 15} (atteso 5) bank=${c.cart!.bank}`]);
// 3) EasyFlash: Ultimax boot from ROMH, uses $DF00 RAM
const efh = new Uint8Array(8192).fill(0xea);
efh.set([0xa9, 0x03, 0x8d, 0x20, 0xd0, 0xa9, 0x42, 0x8d, 0x00, 0xdf, 0xad, 0x00, 0xdf, 0x8d, 0x00, 0x04, 0x4c, 0x10, 0xe0], 0);
efh.set([0x00, 0xe0, 0x00, 0xe0], 0x1ffc); // reset/IRQ → $E000
tests.push(['EasyFlash Ultimax', buildCrt(32, 1, 0, 'TEST EF', [{ bank: 0, load: 0x8000, data: new Uint8Array(8192) }, { bank: 0, load: 0xe000, data: efh }]),
  (c) => `border=${c.vic.regs[0x20] & 15} (atteso 3) ram400=$${c.ram[0x400].toString(16)} (atteso $42)`]);
// 4) 16K normal: ROMH at $A000 readable, code at $8009 copies $A000 byte to border
const l16 = page8k([...CBM80, 0xad, 0x00, 0xa0, 0x8d, 0x20, 0xd0, 0x4c, 0x0f, 0x80]);
const h16 = new Uint8Array(8192); h16[0] = 7;
tests.push(['normal 16K', buildCrt(0, 0, 0, 'TEST 16K', [{ bank: 0, load: 0x8000, data: new Uint8Array([...l16, ...h16]) }]),
  (c) => `border=${c.vic.regs[0x20] & 15} (atteso 7)`]);

const mk = process.env.ORIG ? makeOrigC64 : makeC64;
for (const [name, img, check] of tests) {
  if (process.argv[2]) writeFileSync(`${process.argv[2]}/${name.replace(/\W+/g, '_')}.crt`, img);
  const c = mk();
  const cart = new Cartridge(img);
  c.insertCartridge(cart);
  for (let i = 0; i < 60; i++) c.runFrame();
  console.log(`${name.padEnd(18)} [${cart.typeName}] ${check(c)}`);
}
// without a cartridge the machine still boots to BASIC
const c = mk();
for (let i = 0; i < 150; i++) c.runFrame();
const text = Array.from(c.ram.subarray(0x400, 0x7e8), (v) => { v &= 0x7f; return String.fromCharCode(v < 32 ? v + 64 : v); }).join('');
console.log('senza cartuccia: READY sullo schermo =', text.includes('READY'));
