// .CRT cartridge images and bank-switching hardware

export const CART_TYPES: Record<number, string> = {
  0: 'Normale (8K/16K/Ultimax)',
  4: "Simons' BASIC",
  5: 'Ocean tipo 1',
  7: 'Fun Play / Power Play',
  8: 'Super Games',
  10: 'Epyx FastLoad',
  15: 'C64 Game System / System 3',
  17: 'Dinamic',
  19: 'Magic Desk / Domark / HES',
  32: 'EasyFlash',
};

const UNSUPPORTED: Record<number, string> = {
  1: 'Action Replay', 2: 'KCS Power Cartridge', 3: 'Final Cartridge III', 6: 'Expert Cartridge',
  9: 'Atomic Power', 11: 'Westermann Learning', 12: 'Rex Utility', 13: 'Final Cartridge I', 14: 'Magic Formel',
  18: 'Zaxxon / Super Zaxxon', 21: 'Comal-80', 36: 'Retro Replay', 45: 'Freeze Machine', 60: 'GMod2', 85: 'MegaByter',
};

interface Chip { bank: number; load: number; data: Uint8Array; }

export class Cartridge {
  readonly type: number;
  readonly typeName: string;
  readonly name: string;
  /** line levels: 0 = asserted (active low), as on the real expansion port */
  exrom = 1;
  game = 1;
  private headerExrom: number;
  private headerGame: number;
  private lo: Uint8Array[] = [];   // ROML banks ($8000)
  private hi: Uint8Array[] = [];   // ROMH banks ($A000 or $E000)
  bank = 0;
  private ram = new Uint8Array(256); // EasyFlash RAM at $DF00
  /** called when EXROM/GAME change so the machine can rebuild its memory map */
  onLinesChanged: () => void = () => {};

  constructor(img: Uint8Array) {
    const sig = String.fromCharCode(...img.subarray(0, 16));
    if (!sig.startsWith('C64 CARTRIDGE')) throw new Error('non è un file .CRT per C64');
    const dv = new DataView(img.buffer, img.byteOffset, img.byteLength);
    const hlen = dv.getUint32(0x10);
    this.type = dv.getUint16(0x16);
    this.headerExrom = img[0x18] ? 1 : 0;
    this.headerGame = img[0x19] ? 1 : 0;
    let name = '';
    for (let i = 0x20; i < 0x40 && img[i]; i++) name += String.fromCharCode(img[i]);
    this.name = name.trim() || 'Cartuccia';
    if (!(this.type in CART_TYPES)) {
      const known = UNSUPPORTED[this.type];
      throw new Error(`usa l'hardware di cartuccia tipo ${this.type}${known ? ` (${known})` : ''}, non ancora supportato`);
    }
    this.typeName = CART_TYPES[this.type];

    const chips: Chip[] = [];
    let off = hlen || 0x40;
    while (off + 16 <= img.length) {
      if (String.fromCharCode(...img.subarray(off, off + 4)) !== 'CHIP') break;
      const plen = dv.getUint32(off + 4);
      const bank = dv.getUint16(off + 10);
      const load = dv.getUint16(off + 12);
      const size = dv.getUint16(off + 14);
      chips.push({ bank, load, data: img.slice(off + 16, off + 16 + size) });
      if (plen < 16) break;
      off += plen;
    }
    if (!chips.length) throw new Error('la cartuccia non contiene dati (CHIP)');
    for (const c of chips) {
      const pad = (d: Uint8Array) => { const o = new Uint8Array(8192).fill(0xff); o.set(d.subarray(0, 8192)); return o; };
      if (c.load === 0x8000) {
        this.lo[c.bank] = pad(c.data);
        if (c.data.length > 8192) this.hi[c.bank] = pad(c.data.subarray(8192));
      } else if (c.load === 0xa000 || c.load === 0xe000) {
        this.hi[c.bank] = pad(c.data);
      }
    }
    this.reset();
  }

  reset() {
    this.bank = 0;
    this.ram.fill(0);
    if (this.type === 32) this.setLines(1, 0); // EasyFlash boots in Ultimax mode
    else if (this.type === 4) this.setLines(0, 1); // Simons' BASIC starts in 8K mode
    else this.setLines(this.headerExrom, this.headerGame);
  }

  private setLines(exrom: number, game: number) {
    if (exrom === this.exrom && game === this.game) return;
    this.exrom = exrom; this.game = game;
    this.onLinesChanged();
  }

  readRoml(addr: number): number {
    const b = this.lo[this.bank];
    return b ? b[addr & 0x1fff] : 0xff;
  }
  readRomh(addr: number): number {
    // Ocean 512K and similar map the same 8K bank at $A000 when no separate ROMH chip exists
    const b = this.hi[this.bank] ?? (this.type === 5 ? this.lo[this.bank] : undefined);
    return b ? b[addr & 0x1fff] : 0xff;
  }

  io1Read(addr: number): number {
    switch (this.type) {
      case 4: this.setLines(0, 1); return 0xff;                  // Simons' BASIC: read → 8K
      case 15: this.bank = 0; return 0xff;                        // System 3: read resets bank
      case 17: this.bank = addr & 0x0f; return 0xff;             // Dinamic: read selects bank
      case 10: return 0xff;
    }
    return 0xff;
  }
  io1Write(addr: number, v: number) {
    switch (this.type) {
      case 4: this.setLines(0, 0); break;                         // Simons' BASIC: write → 16K
      case 5: this.bank = v & 0x3f; break;                        // Ocean
      case 7:                                                     // Fun Play
        if (v === 0x86) this.setLines(1, 1);
        else this.bank = ((v >> 3) & 7) | ((v & 1) << 3);
        break;
      case 15: this.bank = addr & 0x3f; break;                    // System 3
      case 19:                                                    // Magic Desk
        this.bank = v & 0x7f;
        this.setLines(v & 0x80 ? 1 : 0, 1);
        break;
      case 32:                                                    // EasyFlash
        if ((addr & 0xff) === 0) this.bank = v & 0x3f;
        else if ((addr & 0xff) === 2) {
          const exrom = v & 2 ? 0 : 1;
          const game = v & 4 ? (v & 1 ? 0 : 1) : 0;
          this.setLines(exrom, game);
        }
        break;
    }
  }
  io2Read(addr: number): number {
    if (this.type === 32) return this.ram[addr & 0xff];
    if (this.type === 10) return this.readRoml(0x1f00 | (addr & 0xff)); // Epyx: last ROM page
    return 0xff;
  }
  io2Write(addr: number, v: number) {
    if (this.type === 32) this.ram[addr & 0xff] = v;
    if (this.type === 8) {                                        // Super Games
      this.bank = v & 3;
      if (v & 4) this.setLines(1, 1); else this.setLines(0, 0);
    }
  }
}
