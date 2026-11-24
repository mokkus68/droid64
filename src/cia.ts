// MOS 6526 Complex Interface Adapter (timers, TOD, ports, interrupts)

export class CIA {
  pra = 0xff; prb = 0xff; ddra = 0; ddrb = 0;
  ta = 0xffff; tb = 0xffff; latchA = 0xffff; latchB = 0xffff;
  cra = 0; crb = 0;
  icrData = 0; icrMask = 0;
  // TOD in BCD
  tod = [0, 0, 0, 1]; // 10ths, sec, min, hr
  alarm = [0, 0, 0, 0];
  todLatch: number[] | null = null;
  todStopped = false;
  private todDiv = 0;
  sdr = 0;

  /** external input hooks */
  readPortA: (cia: CIA) => number = (c) => c.pra | ~c.ddra;
  readPortB: (cia: CIA) => number = (c) => c.prb | ~c.ddrb;
  writePorts: (cia: CIA) => void = () => {};
  onIrq: (active: boolean) => void = () => {};

  reset() {
    this.pra = this.prb = 0xff; this.ddra = this.ddrb = 0;
    this.ta = this.tb = this.latchA = this.latchB = 0xffff;
    this.cra = this.crb = 0; this.icrData = this.icrMask = 0;
    this.tod = [0, 0, 0, 1]; this.todLatch = null; this.todStopped = false;
    this.onIrq(false);
  }

  private setIrq(bit: number) {
    this.icrData |= bit;
    if (this.icrMask & bit) { this.icrData |= 0x80; this.onIrq(true); }
  }

  /** Advance timers by n cycles. */
  clock(n: number) {
    let underflowsA = 0;
    if (this.cra & 1 && !(this.cra & 0x20)) {
      this.ta -= n;
      while (this.ta < 0) {
        underflowsA++;
        this.setIrq(1);
        if (this.cra & 8) { this.cra &= ~1; this.ta = this.latchA; break; }
        this.ta += this.latchA + 1;
      }
    }
    if (this.crb & 1) {
      const mode = (this.crb >> 5) & 3;
      let dec = 0;
      if (mode === 0) dec = n;
      else if (mode === 2 || mode === 3) dec = underflowsA;
      if (dec) {
        this.tb -= dec;
        while (this.tb < 0) {
          this.setIrq(2);
          if (this.crb & 8) { this.crb &= ~1; this.tb = this.latchB; break; }
          this.tb += this.latchB + 1;
        }
      }
    }
  }

  /** Called at 50 Hz (per frame) to drive the TOD clock. */
  tickTOD() {
    if (this.todStopped) return;
    if (++this.todDiv < 5) return;
    this.todDiv = 0;
    const bcdInc = (v: number) => { let lo = (v & 15) + 1, hi = v >> 4; if (lo > 9) { lo = 0; hi++; } return (hi << 4) | lo; };
    const t = this.tod;
    t[0] = (t[0] + 1) % 10;
    if (t[0] === 0) {
      t[1] = bcdInc(t[1]);
      if (t[1] === 0x60) {
        t[1] = 0; t[2] = bcdInc(t[2]);
        if (t[2] === 0x60) {
          t[2] = 0;
          let h = t[3] & 0x1f, pm = t[3] & 0x80;
          h = bcdInc(h);
          if (h === 0x12) pm ^= 0x80;
          if (h === 0x13) h = 1;
          t[3] = h | pm;
        }
      }
    }
    if (t[0] === this.alarm[0] && t[1] === this.alarm[1] && t[2] === this.alarm[2] && t[3] === this.alarm[3]) this.setIrq(4);
  }

  read(reg: number): number {
    switch (reg & 15) {
      case 0: return this.readPortA(this) & 0xff;
      case 1: return this.readPortB(this) & 0xff;
      case 2: return this.ddra;
      case 3: return this.ddrb;
      case 4: return this.ta & 0xff;
      case 5: return (this.ta >> 8) & 0xff;
      case 6: return this.tb & 0xff;
      case 7: return (this.tb >> 8) & 0xff;
      case 8: { const src = this.todLatch ?? this.tod; const v = src[0]; this.todLatch = null; return v; }
      case 9: return (this.todLatch ?? this.tod)[1];
      case 10: return (this.todLatch ?? this.tod)[2];
      case 11: this.todLatch = this.tod.slice(); return this.todLatch[3];
      case 12: return this.sdr;
      case 13: {
        const v = this.icrData;
        this.icrData = 0;
        this.onIrq(false);
        return v;
      }
      case 14: return this.cra & 0xef;
      case 15: return this.crb & 0xef;
    }
    return 0xff;
  }

  write(reg: number, v: number) {
    switch (reg & 15) {
      case 0: this.pra = v; this.writePorts(this); break;
      case 1: this.prb = v; this.writePorts(this); break;
      case 2: this.ddra = v; this.writePorts(this); break;
      case 3: this.ddrb = v; this.writePorts(this); break;
      case 4: this.latchA = (this.latchA & 0xff00) | v; break;
      case 5: this.latchA = (this.latchA & 0xff) | (v << 8); if (!(this.cra & 1)) this.ta = this.latchA; break;
      case 6: this.latchB = (this.latchB & 0xff00) | v; break;
      case 7: this.latchB = (this.latchB & 0xff) | (v << 8); if (!(this.crb & 1)) this.tb = this.latchB; break;
      case 8: case 9: case 10: case 11: {
        const i = (reg & 15) - 8;
        if (i === 3) v = v & 0x9f;
        if (this.crb & 0x80) this.alarm[i] = v;
        else {
          this.tod[i] = v;
          if (i === 3) this.todStopped = true;
          if (i === 0) this.todStopped = false;
        }
        break;
      }
      case 12: this.sdr = v; this.setIrq(8); break;
      case 13:
        if (v & 0x80) this.icrMask |= v & 0x7f; else this.icrMask &= ~v;
        if (this.icrData & this.icrMask & 0x1f) { this.icrData |= 0x80; this.onIrq(true); }
        break;
      case 14:
        if (v & 0x10) this.ta = this.latchA;
        this.cra = v & 0xef; break;
      case 15:
        if (v & 0x10) this.tb = this.latchB;
        this.crb = v & 0xef; break;
    }
  }
}
