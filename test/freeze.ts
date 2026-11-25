// Freezer cartridges: Action Replay (type 1) and Final Cartridge III (type 3)
import { makeOrigC64 } from './util';
import { Cartridge } from '../src/cartridge';
import { buildCrt } from './crtbuild';

const CBM80 = [0x09, 0x80, 0x09, 0x80, 0xc3, 0xc2, 0xcd, 0x38, 0x30];
const page = (fill = 0xea) => new Uint8Array(8192).fill(fill);
const border = (c: ReturnType<typeof makeOrigC64>) => c.vic.regs[0x20] & 15;

// ---- Action Replay: 4 × 8K banks; boot sets border 2; NMI handler at $9F00 sets border 7 ----
{
  const banks = [0, 1, 2, 3].map((b) => { const p = page(); p[0] = 0x10 + b; return p; });
  banks[0].set([...CBM80, 0xa9, 0x02, 0x8d, 0x20, 0xd0, 0x4c, 0x0e, 0x80], 0);
  banks[0][0] = 0x09; // keep the CBM80 vector intact
  banks[0].set([0xa9, 0x07, 0x8d, 0x20, 0xd0, 0x4c, 0x05, 0x9f], 0x1f00); // NMI handler at $9F00 / $FF00
  banks[0].set([0x00, 0x9f, 0x00, 0x9f, 0x00, 0x9f], 0x1ffa);             // NMI/RESET/IRQ vectors → $9F00
  banks[1][0x1f23] = 0x77;
  const img = buildCrt(1, 0, 1, 'TEST AR', banks.map((data, bank) => ({ bank, load: 0x8000, data })));
  const c = makeOrigC64();
  const cart = new Cartridge(img);
  c.insertCartridge(cart);
  for (let i = 0; i < 30; i++) c.runFrame();
  const boot = border(c);
  cart.freeze();
  for (let i = 0; i < 5; i++) c.runFrame();
  const frozen = border(c);
  console.log(`Action Replay: avvio bordo ${boot} (atteso 2), dopo freeze bordo ${frozen} (atteso 7), freezer=${cart.isFreezer}`);
  c.write(0xde00, 0x08); // bank 1, 8K mode
  const rb = [c.read(0x8000), c.read(0xdf23)];
  c.write(0xde00, 0x28); // bank 1 + RAM
  c.write(0x8123, 0x55); c.write(0xdf40, 0x66);
  const ram = [c.read(0x8123), c.read(0xdf40), c.read(0x9f40)];
  c.write(0xde00, 0x08);
  const romAgain = c.read(0x8123);
  c.write(0xde00, 0x04); // switch the cartridge off
  c.write(0x8000, 0x99);
  console.log(`  banco 1: $8000=${rb[0].toString(16)} (atteso 11), $DF23=${rb[1].toString(16)} (atteso 77) | RAM: $8123=${ram[0].toString(16)} $DF40=${ram[1].toString(16)} = $9F40 ${ram[2].toString(16)} (attesi 55 66 66) | RAM spenta → ROM ${romAgain.toString(16)} (atteso ea) | cartuccia spenta: $8000 = RAM del C64 ${c.read(0x8000).toString(16)} (atteso 99)`);
}

// ---- Final Cartridge III: 4 × 16K banks; $DFFF register; NMI vector in ROMH bank 0 ----
{
  const banks = [0, 1, 2, 3].map((b) => { const p = new Uint8Array(16384).fill(0xea); p[0x1e10] = 0x30 + b; return p; });
  banks[0].set([...CBM80, 0xa9, 0x02, 0x8d, 0x20, 0xd0, 0xa9, 0x41, 0x8d, 0xff, 0xdf], 0);  // border 2, then bank 1 (16K, no NMI)
  banks[1].set([0xa9, 0x05, 0x8d, 0x20, 0xd0, 0x4c, 0x18, 0x80], 0x13);                     // continues in bank 1: border 5
  banks[0].set([0xa9, 0x07, 0x8d, 0x20, 0xd0, 0x4c, 0x05, 0xe1], 0x2100);                   // NMI handler at $E100 (ROMH)
  banks[0].set([0x00, 0xe1, 0x00, 0xe1, 0x00, 0xe1], 0x3ffa);                               // vectors at $FFFA
  const img = buildCrt(3, 0, 0, 'TEST FC3', banks.map((data, bank) => ({ bank, load: 0x8000, data })));
  const c = makeOrigC64();
  const cart = new Cartridge(img);
  c.insertCartridge(cart);
  for (let i = 0; i < 30; i++) c.runFrame();
  const run = border(c), bank = cart.bank, io1 = c.read(0xde10);
  cart.freeze();
  for (let i = 0; i < 5; i++) c.runFrame();
  console.log(`Final Cartridge III: avvio e cambio banco → bordo ${run} (atteso 5), banco ${bank} (atteso 1), I/O1 $DE10=${io1.toString(16)} (atteso 31) | dopo freeze bordo ${border(c)} (atteso 7)`);
  c.write(0xdfff, 0x80 | 0x40 | 0x02);
  const hidden = cart.bank;
  c.write(0xdfff, 0x43);
  console.log(`  registro nascosto con il bit 7: banco ${hidden} poi resta ${cart.bank} (atteso 2 e 2)`);
}
