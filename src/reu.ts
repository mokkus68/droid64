// Commodore RAM Expansion Unit (1700 / 1764 / 1750): DMA controller at $DF00-$DF0A.

export interface DmaBus {
  read(addr: number): number;
  write(addr: number, v: number): void;
}

export class REU {
  ram: Uint8Array;
  private mask: number;
  status = 0;
  command = 0x10;
  c64Addr = 0; reuAddr = 0; length = 0xffff;
  private shadowC64 = 0; private shadowReu = 0; private shadowLen = 0xffff;
  irqMask = 0x1f;
  addrCtrl = 0x3f;
  /** cycles the CPU must wait for the last DMA transfer */
  stall = 0;
  onIrq: (active: boolean) => void = () => {};

  constructor(public sizeKB: number, private bus: DmaBus) {
    this.ram = new Uint8Array(sizeKB * 1024);
    this.mask = this.ram.length - 1;
    this.reset();
  }

  reset() {
    this.status = this.sizeKB >= 256 ? 0x10 : 0; // bit 4: 256K-type chips (1764/1750)
    this.command = 0x10;
    this.c64Addr = this.shadowC64 = 0;
    this.reuAddr = this.shadowReu = 0;
    this.length = this.shadowLen = 0xffff;
    this.irqMask = 0x1f;
    this.addrCtrl = 0x3f;
    this.onIrq(false);
  }

  read(addr: number): number {
    switch (addr & 0x1f) {
      case 0: { const v = this.status; this.status &= 0x1f; this.onIrq(false); return v; }
      case 1: return this.command;
      case 2: return this.c64Addr & 0xff;
      case 3: return this.c64Addr >> 8;
      case 4: return this.reuAddr & 0xff;
      case 5: return (this.reuAddr >> 8) & 0xff;
      case 6: return ((this.reuAddr >> 16) & 0x07) | 0xf8;
      case 7: return this.length & 0xff;
      case 8: return this.length >> 8;
      case 9: return this.irqMask | 0x1f;
      case 10: return this.addrCtrl | 0x3f;
    }
    return 0xff;
  }

  /** Read without side effects (for the monitor). */
  peek(addr: number) { return (addr & 0x1f) === 0 ? this.status : this.read(addr); }

  write(addr: number, v: number) {
    switch (addr & 0x1f) {
      case 1:
        this.command = v;
        if ((v & 0x90) === 0x90) this.execute(); // execute now, no $FF00 trigger
        break;
      case 2: this.c64Addr = this.shadowC64 = (this.shadowC64 & 0xff00) | v; break;
      case 3: this.c64Addr = this.shadowC64 = (this.shadowC64 & 0xff) | (v << 8); break;
      case 4: this.reuAddr = this.shadowReu = (this.shadowReu & 0x7ff00) | v; break;
      case 5: this.reuAddr = this.shadowReu = (this.shadowReu & 0x700ff) | (v << 8); break;
      case 6: this.reuAddr = this.shadowReu = (this.shadowReu & 0xffff) | ((v & 0x07) << 16); break;
      case 7: this.length = this.shadowLen = (this.shadowLen & 0xff00) | v; break;
      case 8: this.length = this.shadowLen = (this.shadowLen & 0xff) | (v << 8); break;
      case 9: this.irqMask = v & 0xe0; this.updateIrq(); break;
      case 10: this.addrCtrl = v & 0xc0; break;
    }
  }

  /** A CPU write to $FF00 starts a transfer armed with the trigger enabled. */
  ff00Written() {
    if ((this.command & 0x90) === 0x80) this.execute();
  }

  private updateIrq() {
    const pending = (this.irqMask & 0x80) && (this.status & this.irqMask & 0x60);
    if (pending) this.status |= 0x80;
    this.onIrq(!!pending);
  }

  private execute() {
    const type = this.command & 3;
    const fixC64 = (this.addrCtrl & 0x80) !== 0, fixReu = (this.addrCtrl & 0x40) !== 0;
    let c = this.c64Addr, r = this.reuAddr, n = this.length || 0x10000;
    let done = 0, fault = false;
    while (n > 0) {
      const ra = r & this.mask;
      switch (type) {
        case 0: this.ram[ra] = this.bus.read(c); break;                   // stash: C64 → REU
        case 1: this.bus.write(c, this.ram[ra]); break;                   // fetch: REU → C64
        case 2: { const a = this.bus.read(c); this.bus.write(c, this.ram[ra]); this.ram[ra] = a; break; } // swap
        case 3: if (this.bus.read(c) !== this.ram[ra]) fault = true; break; // verify
      }
      done++;
      if (!fixC64) c = (c + 1) & 0xffff;
      if (!fixReu) r = (r + 1) & 0x7ffff;
      n--;
      if (fault) break;
    }
    this.stall = done * (type === 2 ? 2 : 1);
    if (this.command & 0x20) {
      // autoload: registers go back to the values written by the program
      this.c64Addr = this.shadowC64; this.reuAddr = this.shadowReu; this.length = this.shadowLen;
    } else {
      this.c64Addr = c; this.reuAddr = r; this.length = n === 0 ? 1 : n;
    }
    this.status |= fault ? 0x20 : 0x40;
    if (fault && n === 0) this.status |= 0x40;
    this.command = (this.command & 0x7f) | 0x10;
    this.updateIrq();
  }
}
