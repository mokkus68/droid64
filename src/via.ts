// MOS 6522 Versatile Interface Adapter (as used twice in the 1541 drive)

export class VIA {
  orb = 0; ora = 0; ddrb = 0; ddra = 0;
  t1c = 0xffff; t1l = 0xffff; t2c = 0xffff; t2l = 0xff;
  private t1Running = false;
  private t2Running = false;
  acr = 0; pcr = 0; ifr = 0; ier = 0; sr = 0;
  private ca1 = false; // last CA1 input level
  latchA = 0;          // port A input latch (set on CA1 edge when latching is on)

  /** pin inputs (only bits configured as inputs matter) */
  readPortA: () => number = () => 0xff;
  readPortB: () => number = () => 0xff;
  /** called after a write that may change port outputs or PCR */
  onPortsChanged: () => void = () => {};
  onIrq: (active: boolean) => void = () => {};

  reset() {
    this.orb = this.ora = this.ddrb = this.ddra = 0;
    this.acr = this.pcr = this.ifr = this.ier = this.sr = 0;
    this.t1Running = this.t2Running = false;
    this.t1c = this.t1l = this.t2c = 0xffff;
    this.updateIrq();
    this.onPortsChanged();
  }

  get irq() { return (this.ifr & this.ier & 0x7f) !== 0; }
  private updateIrq() {
    if (this.ifr & this.ier & 0x7f) this.ifr |= 0x80; else this.ifr &= 0x7f;
    this.onIrq(this.irq);
  }
  setFlag(bit: number) { this.ifr |= bit; this.updateIrq(); }
  private clearFlag(bit: number) { this.ifr &= ~bit; this.updateIrq(); }

  /** Drive the CA1 input pin; sets the CA1 interrupt flag on the active edge. */
  setCA1(level: boolean) {
    if (level === this.ca1) return;
    this.ca1 = level;
    const positive = (this.pcr & 1) !== 0;
    if (level === positive) {
      if (this.acr & 1) this.latchA = this.readPortA();
      this.setFlag(0x02);
    }
  }

  /** Port B value seen on the pins from the outputs' side (outputs driven, inputs pulled high). */
  get portBOut() { return (this.orb & this.ddrb) | (~this.ddrb & 0xff); }
  get portAOut() { return (this.ora & this.ddra) | (~this.ddra & 0xff); }

  clock(n: number) {
    if (this.t1Running || (this.acr & 0x40)) {
      this.t1c -= n;
      while (this.t1c < 0) {
        if (this.t1Running) this.setFlag(0x40);
        if (this.acr & 0x40) { this.t1c += this.t1l + 2; }
        else { this.t1Running = false; this.t1c += 0x10000; }
      }
    }
    if (!(this.acr & 0x20)) {
      this.t2c -= n;
      while (this.t2c < 0) {
        if (this.t2Running) { this.setFlag(0x20); this.t2Running = false; }
        this.t2c += 0x10000;
      }
    }
  }

  read(reg: number): number {
    switch (reg & 15) {
      case 0: {
        this.clearFlag(0x18);
        const pins = this.readPortB();
        return (this.orb & this.ddrb) | (pins & ~this.ddrb & 0xff);
      }
      case 1: case 15: {
        if ((reg & 15) === 1) this.clearFlag(0x03);
        const pins = (this.acr & 1) ? this.latchA : this.readPortA();
        return (this.ora & this.ddra) | (pins & ~this.ddra & 0xff);
      }
      case 2: return this.ddrb;
      case 3: return this.ddra;
      case 4: this.clearFlag(0x40); return this.t1c & 0xff;
      case 5: return (this.t1c >> 8) & 0xff;
      case 6: return this.t1l & 0xff;
      case 7: return (this.t1l >> 8) & 0xff;
      case 8: this.clearFlag(0x20); return this.t2c & 0xff;
      case 9: return (this.t2c >> 8) & 0xff;
      case 10: return this.sr;
      case 11: return this.acr;
      case 12: return this.pcr;
      case 13: return this.ifr;
      case 14: return this.ier | 0x80;
    }
    return 0xff;
  }

  write(reg: number, v: number) {
    switch (reg & 15) {
      case 0: this.orb = v; this.clearFlag(0x18); this.onPortsChanged(); break;
      case 1: this.ora = v; this.clearFlag(0x03); this.onPortsChanged(); break;
      case 15: this.ora = v; this.onPortsChanged(); break;
      case 2: this.ddrb = v; this.onPortsChanged(); break;
      case 3: this.ddra = v; this.onPortsChanged(); break;
      case 4: case 6: this.t1l = (this.t1l & 0xff00) | v; break;
      case 5:
        this.t1l = (this.t1l & 0xff) | (v << 8);
        this.t1c = this.t1l + 1; this.t1Running = true;
        this.clearFlag(0x40);
        break;
      case 7: this.t1l = (this.t1l & 0xff) | (v << 8); this.clearFlag(0x40); break;
      case 8: this.t2l = v; break;
      case 9:
        this.t2c = (this.t2l | (v << 8)) + 1; this.t2Running = true;
        this.clearFlag(0x20);
        break;
      case 10: this.sr = v; break;
      case 11: this.acr = v; break;
      case 12: this.pcr = v; this.onPortsChanged(); break;
      case 13: this.ifr &= ~(v & 0x7f); this.updateIrq(); break;
      case 14:
        if (v & 0x80) this.ier |= v & 0x7f; else this.ier &= ~v & 0x7f;
        this.updateIrq();
        break;
    }
  }
}
