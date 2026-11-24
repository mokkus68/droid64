// MOS 6510 CPU emulation (instruction-stepped, NMOS 6502 core incl. undocumented opcodes)

export interface Bus {
  read(addr: number): number;
  write(addr: number, value: number): void;
}

const enum M { IMP, ACC, IMM, ZP, ZPX, ZPY, ABS, ABX, ABY, IND, IZX, IZY, REL }

const OPS = [
  'BRK','ORA','JAM','SLO','NOP','ORA','ASL','SLO','PHP','ORA','ASL','ANC','NOP','ORA','ASL','SLO',
  'BPL','ORA','JAM','SLO','NOP','ORA','ASL','SLO','CLC','ORA','NOP','SLO','NOP','ORA','ASL','SLO',
  'JSR','AND','JAM','RLA','BIT','AND','ROL','RLA','PLP','AND','ROL','ANC','BIT','AND','ROL','RLA',
  'BMI','AND','JAM','RLA','NOP','AND','ROL','RLA','SEC','AND','NOP','RLA','NOP','AND','ROL','RLA',
  'RTI','EOR','JAM','SRE','NOP','EOR','LSR','SRE','PHA','EOR','LSR','ALR','JMP','EOR','LSR','SRE',
  'BVC','EOR','JAM','SRE','NOP','EOR','LSR','SRE','CLI','EOR','NOP','SRE','NOP','EOR','LSR','SRE',
  'RTS','ADC','JAM','RRA','NOP','ADC','ROR','RRA','PLA','ADC','ROR','ARR','JMP','ADC','ROR','RRA',
  'BVS','ADC','JAM','RRA','NOP','ADC','ROR','RRA','SEI','ADC','NOP','RRA','NOP','ADC','ROR','RRA',
  'NOP','STA','NOP','SAX','STY','STA','STX','SAX','DEY','NOP','TXA','ANE','STY','STA','STX','SAX',
  'BCC','STA','JAM','SHA','STY','STA','STX','SAX','TYA','STA','TXS','TAS','SHY','STA','SHX','SHA',
  'LDY','LDA','LDX','LAX','LDY','LDA','LDX','LAX','TAY','LDA','TAX','LXA','LDY','LDA','LDX','LAX',
  'BCS','LDA','JAM','LAX','LDY','LDA','LDX','LAX','CLV','LDA','TSX','LAS','LDY','LDA','LDX','LAX',
  'CPY','CMP','NOP','DCP','CPY','CMP','DEC','DCP','INY','CMP','DEX','SBX','CPY','CMP','DEC','DCP',
  'BNE','CMP','JAM','DCP','NOP','CMP','DEC','DCP','CLD','CMP','NOP','DCP','NOP','CMP','DEC','DCP',
  'CPX','SBC','NOP','ISC','CPX','SBC','INC','ISC','INX','SBC','NOP','SBC','CPX','SBC','INC','ISC',
  'BEQ','SBC','JAM','ISC','NOP','SBC','INC','ISC','SED','SBC','NOP','ISC','NOP','SBC','INC','ISC',
];

// addressing mode per column pattern, with exceptions patched below
const MODES: number[] = new Array(256);
const CYCLES = [
  7,6,0,8,3,3,5,5,3,2,2,2,4,4,6,6, 2,5,0,8,4,4,6,6,2,4,2,7,4,4,7,7,
  6,6,0,8,3,3,5,5,4,2,2,2,4,4,6,6, 2,5,0,8,4,4,6,6,2,4,2,7,4,4,7,7,
  6,6,0,8,3,3,5,5,3,2,2,2,3,4,6,6, 2,5,0,8,4,4,6,6,2,4,2,7,4,4,7,7,
  6,6,0,8,3,3,5,5,4,2,2,2,5,4,6,6, 2,5,0,8,4,4,6,6,2,4,2,7,4,4,7,7,
  2,6,2,6,3,3,3,3,2,2,2,2,4,4,4,4, 2,6,0,6,4,4,4,4,2,5,2,5,5,5,5,5,
  2,6,2,6,3,3,3,3,2,2,2,2,4,4,4,4, 2,5,0,5,4,4,4,4,2,4,2,4,4,4,4,4,
  2,6,2,8,3,3,5,5,2,2,2,2,4,4,6,6, 2,5,0,8,4,4,6,6,2,4,2,7,4,4,7,7,
  2,6,2,8,3,3,5,5,2,2,2,2,4,4,6,6, 2,5,0,8,4,4,6,6,2,4,2,7,4,4,7,7,
];
for (let op = 0; op < 256; op++) {
  const hi = op >> 4, lo = op & 15, odd = hi & 1;
  let m: number;
  switch (lo) {
    case 0: m = odd ? M.REL : (hi === 2 ? M.ABS : (hi >= 8 ? M.IMM : M.IMP)); break;
    case 1: case 3: m = odd ? M.IZY : M.IZX; break;
    case 2: m = hi >= 8 && !odd ? M.IMM : M.IMP; break;
    case 4: case 5: case 6: case 7: m = odd ? M.ZPX : M.ZP; break;
    case 8: m = M.IMP; break;
    case 9: case 11: m = odd ? M.ABY : M.IMM; break;
    case 10: m = (!odd && hi < 8) ? M.ACC : M.IMP; break;
    default: m = odd ? M.ABX : M.ABS; break;
  }
  MODES[op] = m;
}
// exceptions
MODES[0x6c] = M.IND;
for (const op of [0x96, 0x97, 0xb6, 0xb7]) MODES[op] = M.ZPY;
for (const op of [0x9e, 0x9f, 0xbe, 0xbf]) MODES[op] = M.ABY;
MODES[0x00] = M.IMP; // BRK handled specially

// opcodes whose abx/aby/izy page cross adds a cycle
const READ_PENALTY = new Set(['LDA','LDX','LDY','EOR','AND','ORA','ADC','SBC','CMP','LAX','LAS','NOP']);
const PENALTY = new Uint8Array(256);
for (let op = 0; op < 256; op++) {
  const m = MODES[op];
  if ((m === M.ABX || m === M.ABY || m === M.IZY) && READ_PENALTY.has(OPS[op])) PENALTY[op] = 1;
}
const OPNAMES = Array.from(new Set(OPS));
const OPID = new Uint8Array(256);
for (let i = 0; i < 256; i++) OPID[i] = OPNAMES.indexOf(OPS[i]);
const id = (n: string) => OPNAMES.indexOf(n);
const O = Object.fromEntries(OPNAMES.map((n) => [n, id(n)])) as Record<string, number>;

export const FLAG_C = 1, FLAG_Z = 2, FLAG_I = 4, FLAG_D = 8, FLAG_B = 16, FLAG_U = 32, FLAG_V = 64, FLAG_N = 128;

export class CPU {
  a = 0; x = 0; y = 0; s = 0xfd; pc = 0;
  c = 0; z = 0; i = 1; d = 0; v = 0; n = 0;
  irqLines = 0;          // bitmask of devices asserting IRQ
  nmiLine = false;       // current NMI level
  private nmiPrev = false;
  private nmiPending = false;
  jammed = false;
  cycles = 0;            // total cycles executed
  trap: ((cpu: CPU) => boolean) | null = null; // called before each instruction when set

  constructor(private bus: Bus) {}

  reset() {
    this.s = 0xfd; this.i = 1; this.d = 0; this.jammed = false;
    this.pc = this.bus.read(0xfffc) | (this.bus.read(0xfffd) << 8);
    this.nmiPending = false; this.nmiPrev = false;
  }

  getP() {
    return this.c | (this.z << 1) | (this.i << 2) | (this.d << 3) | FLAG_U | (this.v << 6) | (this.n << 7);
  }
  setP(p: number) {
    this.c = p & 1; this.z = (p >> 1) & 1; this.i = (p >> 2) & 1; this.d = (p >> 3) & 1;
    this.v = (p >> 6) & 1; this.n = (p >> 7) & 1;
  }
  setNMI(level: boolean) {
    if (level && !this.nmiPrev) this.nmiPending = true;
    this.nmiPrev = level; this.nmiLine = level;
  }
  triggerNMI() { this.nmiPending = true; }

  private push(v: number) { this.bus.write(0x100 | this.s, v); this.s = (this.s - 1) & 0xff; }
  private pop() { this.s = (this.s + 1) & 0xff; return this.bus.read(0x100 | this.s); }
  private nz(v: number) { this.z = v === 0 ? 1 : 0; this.n = (v >> 7) & 1; return v; }

  private interrupt(vector: number, brk: boolean) {
    this.push(this.pc >> 8); this.push(this.pc & 0xff);
    this.push(this.getP() | (brk ? FLAG_B : 0));
    this.i = 1;
    this.pc = this.bus.read(vector) | (this.bus.read(vector + 1) << 8);
  }

  private adc(v: number) {
    if (this.d) {
      let lo = (this.a & 0x0f) + (v & 0x0f) + this.c;
      let hi = (this.a & 0xf0) + (v & 0xf0);
      this.z = ((this.a + v + this.c) & 0xff) === 0 ? 1 : 0;
      if (lo > 9) { lo += 6; hi += 0x10; }
      this.n = (hi >> 7) & 1;
      this.v = (~(this.a ^ v) & (this.a ^ hi) & 0x80) ? 1 : 0;
      if (hi > 0x90) hi += 0x60;
      this.c = hi > 0xff ? 1 : 0;
      this.a = ((lo & 0x0f) | (hi & 0xf0)) & 0xff;
    } else {
      const r = this.a + v + this.c;
      this.v = (~(this.a ^ v) & (this.a ^ r) & 0x80) ? 1 : 0;
      this.c = r > 0xff ? 1 : 0;
      this.a = this.nz(r & 0xff);
    }
  }
  private sbc(v: number) {
    const r = this.a - v - (1 - this.c);
    if (this.d) {
      let lo = (this.a & 0x0f) - (v & 0x0f) - (1 - this.c);
      let hi = (this.a & 0xf0) - (v & 0xf0);
      if (lo & 0x10) { lo -= 6; hi -= 0x10; }
      if (hi & 0x100) hi -= 0x60;
      this.v = ((this.a ^ v) & (this.a ^ r) & 0x80) ? 1 : 0;
      this.c = r >= 0 ? 1 : 0;
      this.nz(r & 0xff);
      this.a = ((lo & 0x0f) | (hi & 0xf0)) & 0xff;
    } else {
      this.v = ((this.a ^ v) & (this.a ^ r) & 0x80) ? 1 : 0;
      this.c = r >= 0 ? 1 : 0;
      this.a = this.nz(r & 0xff);
    }
  }
  private cmp(reg: number, v: number) {
    const r = reg - v;
    this.c = r >= 0 ? 1 : 0;
    this.nz(r & 0xff);
  }

  /** Execute one instruction (or service an interrupt). Returns cycles used. */
  step(): number {
    const bus = this.bus;
    if (this.nmiPending) {
      this.nmiPending = false;
      this.interrupt(0xfffa, false);
      this.cycles += 7; return 7;
    }
    if (this.irqLines && !this.i) {
      this.interrupt(0xfffe, false);
      this.cycles += 7; return 7;
    }
    if (this.jammed) { this.cycles += 2; return 2; }
    if (this.trap && this.trap(this)) { this.cycles += 6; return 6; }

    const op = bus.read(this.pc);
    let pc = (this.pc + 1) & 0xffff;
    let cyc = CYCLES[op];
    let addr = 0;

    switch (MODES[op]) {
      case M.IMP: case M.ACC: break;
      case M.IMM: addr = pc; pc = (pc + 1) & 0xffff; break;
      case M.ZP: addr = bus.read(pc); pc = (pc + 1) & 0xffff; break;
      case M.ZPX: addr = (bus.read(pc) + this.x) & 0xff; pc = (pc + 1) & 0xffff; break;
      case M.ZPY: addr = (bus.read(pc) + this.y) & 0xff; pc = (pc + 1) & 0xffff; break;
      case M.ABS: addr = bus.read(pc) | (bus.read((pc + 1) & 0xffff) << 8); pc = (pc + 2) & 0xffff; break;
      case M.ABX: {
        const base = bus.read(pc) | (bus.read((pc + 1) & 0xffff) << 8); pc = (pc + 2) & 0xffff;
        addr = (base + this.x) & 0xffff;
        if (PENALTY[op] && (base & 0xff00) !== (addr & 0xff00)) cyc++;
        break;
      }
      case M.ABY: {
        const base = bus.read(pc) | (bus.read((pc + 1) & 0xffff) << 8); pc = (pc + 2) & 0xffff;
        addr = (base + this.y) & 0xffff;
        if (PENALTY[op] && (base & 0xff00) !== (addr & 0xff00)) cyc++;
        break;
      }
      case M.IND: {
        const ptr = bus.read(pc) | (bus.read((pc + 1) & 0xffff) << 8); pc = (pc + 2) & 0xffff;
        addr = bus.read(ptr) | (bus.read((ptr & 0xff00) | ((ptr + 1) & 0xff)) << 8);
        break;
      }
      case M.IZX: {
        const zp = (bus.read(pc) + this.x) & 0xff; pc = (pc + 1) & 0xffff;
        addr = bus.read(zp) | (bus.read((zp + 1) & 0xff) << 8);
        break;
      }
      case M.IZY: {
        const zp = bus.read(pc); pc = (pc + 1) & 0xffff;
        const base = bus.read(zp) | (bus.read((zp + 1) & 0xff) << 8);
        addr = (base + this.y) & 0xffff;
        if (PENALTY[op] && (base & 0xff00) !== (addr & 0xff00)) cyc++;
        break;
      }
      case M.REL: {
        const off = bus.read(pc); pc = (pc + 1) & 0xffff;
        addr = (pc + (off < 128 ? off : off - 256)) & 0xffff;
        break;
      }
    }
    this.pc = pc;

    let v: number, r: number;
    switch (OPID[op]) {
      case O.LDA: this.a = this.nz(bus.read(addr)); break;
      case O.LDX: this.x = this.nz(bus.read(addr)); break;
      case O.LDY: this.y = this.nz(bus.read(addr)); break;
      case O.STA: bus.write(addr, this.a); break;
      case O.STX: bus.write(addr, this.x); break;
      case O.STY: bus.write(addr, this.y); break;
      case O.TAX: this.x = this.nz(this.a); break;
      case O.TAY: this.y = this.nz(this.a); break;
      case O.TXA: this.a = this.nz(this.x); break;
      case O.TYA: this.a = this.nz(this.y); break;
      case O.TSX: this.x = this.nz(this.s); break;
      case O.TXS: this.s = this.x; break;
      case O.PHA: this.push(this.a); break;
      case O.PHP: this.push(this.getP() | FLAG_B); break;
      case O.PLA: this.a = this.nz(this.pop()); break;
      case O.PLP: this.setP(this.pop()); break;
      case O.AND: this.a = this.nz(this.a & bus.read(addr)); break;
      case O.ORA: this.a = this.nz(this.a | bus.read(addr)); break;
      case O.EOR: this.a = this.nz(this.a ^ bus.read(addr)); break;
      case O.ADC: this.adc(bus.read(addr)); break;
      case O.SBC: this.sbc(bus.read(addr)); break;
      case O.CMP: this.cmp(this.a, bus.read(addr)); break;
      case O.CPX: this.cmp(this.x, bus.read(addr)); break;
      case O.CPY: this.cmp(this.y, bus.read(addr)); break;
      case O.BIT: v = bus.read(addr); this.z = (this.a & v) === 0 ? 1 : 0; this.n = (v >> 7) & 1; this.v = (v >> 6) & 1; break;
      case O.INC: v = bus.read(addr); bus.write(addr, v); bus.write(addr, this.nz((v + 1) & 0xff)); break;
      case O.DEC: v = bus.read(addr); bus.write(addr, v); bus.write(addr, this.nz((v - 1) & 0xff)); break;
      case O.INX: this.x = this.nz((this.x + 1) & 0xff); break;
      case O.INY: this.y = this.nz((this.y + 1) & 0xff); break;
      case O.DEX: this.x = this.nz((this.x - 1) & 0xff); break;
      case O.DEY: this.y = this.nz((this.y - 1) & 0xff); break;
      case O.ASL:
        if (MODES[op] === M.ACC) { this.c = this.a >> 7; this.a = this.nz((this.a << 1) & 0xff); }
        else { v = bus.read(addr); bus.write(addr, v); this.c = v >> 7; bus.write(addr, this.nz((v << 1) & 0xff)); }
        break;
      case O.LSR:
        if (MODES[op] === M.ACC) { this.c = this.a & 1; this.a = this.nz(this.a >> 1); }
        else { v = bus.read(addr); bus.write(addr, v); this.c = v & 1; bus.write(addr, this.nz(v >> 1)); }
        break;
      case O.ROL:
        if (MODES[op] === M.ACC) { r = ((this.a << 1) | this.c) & 0xff; this.c = this.a >> 7; this.a = this.nz(r); }
        else { v = bus.read(addr); bus.write(addr, v); r = ((v << 1) | this.c) & 0xff; this.c = v >> 7; bus.write(addr, this.nz(r)); }
        break;
      case O.ROR:
        if (MODES[op] === M.ACC) { r = (this.a >> 1) | (this.c << 7); this.c = this.a & 1; this.a = this.nz(r); }
        else { v = bus.read(addr); bus.write(addr, v); r = (v >> 1) | (this.c << 7); this.c = v & 1; bus.write(addr, this.nz(r)); }
        break;
      case O.JMP: this.pc = addr; break;
      case O.JSR: {
        const ret = (this.pc - 1) & 0xffff;
        this.push(ret >> 8); this.push(ret & 0xff); this.pc = addr; break;
      }
      case O.RTS: this.pc = ((this.pop() | (this.pop() << 8)) + 1) & 0xffff; break;
      case O.RTI: this.setP(this.pop()); this.pc = this.pop() | (this.pop() << 8); break;
      case O.BRK: this.pc = (this.pc + 1) & 0xffff; this.interrupt(0xfffe, true); break;
      case O.BPL: if (!this.n) cyc += this.branch(addr); break;
      case O.BMI: if (this.n) cyc += this.branch(addr); break;
      case O.BVC: if (!this.v) cyc += this.branch(addr); break;
      case O.BVS: if (this.v) cyc += this.branch(addr); break;
      case O.BCC: if (!this.c) cyc += this.branch(addr); break;
      case O.BCS: if (this.c) cyc += this.branch(addr); break;
      case O.BNE: if (!this.z) cyc += this.branch(addr); break;
      case O.BEQ: if (this.z) cyc += this.branch(addr); break;
      case O.CLC: this.c = 0; break;
      case O.SEC: this.c = 1; break;
      case O.CLI: this.i = 0; break;
      case O.SEI: this.i = 1; break;
      case O.CLD: this.d = 0; break;
      case O.SED: this.d = 1; break;
      case O.CLV: this.v = 0; break;
      case O.NOP: if (MODES[op] !== M.IMP) bus.read(addr); break;
      // ---- undocumented ----
      case O.LAX: this.a = this.x = this.nz(bus.read(addr)); break;
      case O.SAX: bus.write(addr, this.a & this.x); break;
      case O.DCP: v = (bus.read(addr) - 1) & 0xff; bus.write(addr, v); this.cmp(this.a, v); break;
      case O.ISC: v = (bus.read(addr) + 1) & 0xff; bus.write(addr, v); this.sbc(v); break;
      case O.SLO: v = bus.read(addr); this.c = v >> 7; v = (v << 1) & 0xff; bus.write(addr, v); this.a = this.nz(this.a | v); break;
      case O.RLA: v = bus.read(addr); r = ((v << 1) | this.c) & 0xff; this.c = v >> 7; bus.write(addr, r); this.a = this.nz(this.a & r); break;
      case O.SRE: v = bus.read(addr); this.c = v & 1; v >>= 1; bus.write(addr, v); this.a = this.nz(this.a ^ v); break;
      case O.RRA: v = bus.read(addr); r = (v >> 1) | (this.c << 7); this.c = v & 1; bus.write(addr, r); this.adc(r); break;
      case O.ANC: this.a = this.nz(this.a & bus.read(addr)); this.c = this.n; break;
      case O.ALR: v = this.a & bus.read(addr); this.c = v & 1; this.a = this.nz(v >> 1); break;
      case O.ARR: {
        v = this.a & bus.read(addr);
        this.a = this.nz((v >> 1) | (this.c << 7));
        this.c = (this.a >> 6) & 1;
        this.v = ((this.a >> 6) ^ (this.a >> 5)) & 1;
        break;
      }
      case O.SBX: v = (this.a & this.x) - bus.read(addr); this.c = v >= 0 ? 1 : 0; this.x = this.nz(v & 0xff); break;
      case O.ANE: this.a = this.nz((this.a | 0xee) & this.x & bus.read(addr)); break;
      case O.LXA: this.a = this.x = this.nz((this.a | 0xee) & bus.read(addr)); break;
      case O.LAS: v = bus.read(addr) & this.s; this.a = this.x = this.s = this.nz(v); break;
      case O.SHA: bus.write(addr, this.a & this.x & (((addr >> 8) + 1) & 0xff)); break;
      case O.SHX: bus.write(addr, this.x & (((addr >> 8) + 1) & 0xff)); break;
      case O.SHY: bus.write(addr, this.y & (((addr >> 8) + 1) & 0xff)); break;
      case O.TAS: this.s = this.a & this.x; bus.write(addr, this.s & (((addr >> 8) + 1) & 0xff)); break;
      case O.JAM: this.jammed = true; this.pc = (this.pc - 1) & 0xffff; cyc = 2; break;
    }
    this.cycles += cyc;
    return cyc;
  }

  private branch(target: number): number {
    const extra = (target & 0xff00) !== (this.pc & 0xff00) ? 2 : 1;
    this.pc = target;
    return extra;
  }
}
