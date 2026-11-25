// Timing-critical 2-bit fastloader transfer between drive code (started with M-E) and the C64.
// The C64 samples the bus a fixed number of cycles (D) after a sync edge; only a narrow window
// of D values can work, so this checks the cycle accuracy of the C64 <-> 1541 lock-step.
import { makeOrigC64 } from './util';
import { parseD64 } from '../src/media';
import { readFileSync } from 'fs';

const img = new Uint8Array(readFileSync(process.argv[2]));
const rom = new Uint8Array(readFileSync(process.env.DRIVEROM!));

// ---- tiny assembler helpers ----
function asm(origin: number, build: (a: Asm) => void): number[] {
  const a = new Asm(origin);
  build(a); a.pass2 = true; a.code = []; build(a);
  return a.code;
}
class Asm {
  code: number[] = [];
  labels: Record<string, number> = {};
  pass2 = false;
  constructor(public origin: number) {}
  get pc() { return this.origin + this.code.length; }
  label(n: string) { this.labels[n] = this.pc; }
  b(...bytes: number[]) { this.code.push(...bytes); }
  w(op: number, addr: number) { this.code.push(op, addr & 255, addr >> 8); }
  br(op: number, l: string) {
    const t = this.labels[l] ?? this.pc;
    const off = t - (this.pc + 2);
    if (this.pass2 && (off < -128 || off > 127)) throw new Error('branch out of range ' + l);
    this.code.push(op, off & 255);
  }
  addr(l: string) { return this.labels[l] ?? 0; }
}

// ---- drive side, at $0500: send $F000-$F0FF ----
const driveCode = asm(0x0500, (a) => {
  a.b(0x78);                          // SEI
  a.b(0xa9, 0x00); a.w(0x8d, 0x1800); // release lines
  a.b(0xa2, 0x00);                    // LDX #0
  a.label('loop');
  a.w(0xbd, 0xf000);                  // LDA $F000,X
  for (let i = 0; i < 4; i++) {       // encode 4 pairs into $10-$13
    a.b(0x48, 0x29, 0x03, 0xa8);      // PHA, AND #3, TAY
    a.w(0xb9, a.addr('tbl'));         // LDA tbl,Y
    a.b(0x85, 0x10 + i);              // STA $10+i
    a.b(0x68, 0x4a, 0x4a);            // PLA, LSR, LSR
  }
  a.label('w1'); a.w(0xad, 0x1800); a.b(0x29, 0x04); a.br(0xf0, 'w1'); // wait CLK low
  a.label('w2'); a.w(0xad, 0x1800); a.b(0x29, 0x04); a.br(0xd0, 'w2'); // wait CLK released: sync
  for (let i = 0; i < 4; i++) {       // 12 cycles per pair
    a.b(0xa5, 0x10 + i); a.w(0x8d, 0x1800); a.b(0x24, 0x00, 0xea);
  }
  a.b(0xa9, 0x00); a.w(0x8d, 0x1800); // release
  a.b(0xe8); a.br(0xd0, 'loop');      // INX, BNE
  a.b(0x58, 0x60);                    // CLI, RTS
  a.label('tbl'); a.b(0x00, 0x02, 0x08, 0x0a); // pair → DATA OUT (bit1) / CLK OUT (bit3)
});

// ---- C64 side, at $C000: receive 256 × 4 raw samples into $C200/$C300/$C400/$C500 ----
const pad = (a: Asm, n: number) => { if (n % 2) { a.b(0x24, 0x00); n -= 3; } while (n > 0) { a.b(0xea); n -= 2; } };
const c64Code = (D: number) => asm(0xc000, (a) => {
  a.b(0x78);                                   // SEI
  a.b(0xa0, 0x00); a.label('dl'); a.b(0xa2, 0x00); a.label('dl2'); a.b(0xca); a.br(0xd0, 'dl2'); a.b(0x88); a.br(0xd0, 'dl'); // ~330k cycles: let the drive start
  a.b(0xa2, 0x00);
  a.label('loop');
  a.w(0xad, 0xdd00); a.b(0x29, 0x07, 0x09, 0x10); a.w(0x8d, 0xdd00); // pull CLK low
  a.b(0xa0, 0x3c); a.label('d'); a.b(0x88); a.br(0xd0, 'd');           // wait ~300 cycles: drive is ready
  a.b(0x29, 0x07); a.w(0x8d, 0xdd00);                                  // release CLK → sync edge
  pad(a, D);
  for (let i = 0; i < 4; i++) {
    a.w(0xad, 0xdd00); a.w(0x9d, 0xc200 + i * 0x100);                  // LDA $DD00, STA tbl,X (9 cycles)
    if (i < 3) a.b(0x24, 0x00);                                        // +3 = 12 cycles per pair
  }
  a.b(0xe8); a.br(0xd0, 'loop');
  a.b(0x58, 0x60);
});

function attempt(D: number): number {
  const c = makeOrigC64();
  c.attachDrive(rom);
  c.mountDisk(parseD64(img), img);
  for (let i = 0; i < 150; i++) c.runFrame();
  c.drive!.ram.set(driveCode, 0x0500);
  c.ram.set(c64Code(D), 0xc000);
  c.typeText('POKE53265,11:OPEN15,8,15,"M-E"+CHR$(0)+CHR$(5):SYS49152\n');
  const pcs = new Map<number, number>();
  for (let i = 0; i < 400; i++) {
    c.runFrame();
    if (process.env.DEBUG && i % 20 === 0) { const pc = c.drive!.cpu.pc; console.log(`frame ${i} drvcyc ${Math.round(c.drive!.cycles)} c64now ${Math.round((c as any).now)} drive pc ${pc.toString(16)} c64 pc ${c.cpu.pc.toString(16)} X=${c.cpu.x} dd00=${c.cia2.pra.toString(16)}/${c.cia2.ddra.toString(16)} drv1800=${c.drive!.via1.orb.toString(16)}/${c.drive!.via1.ddrb.toString(16)}`); }
  }
  if (process.env.DEBUG) console.log('raw', Array.from(c.ram.subarray(0xc200, 0xc208), (v) => v.toString(16)).join(' '));
  let ok = 0;
  for (let x = 0; x < 256; x++) {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const s = c.ram[0xc200 + i * 0x100 + x];
      const pair = ((s & 0x40) ? 0 : 2) | ((s & 0x80) ? 0 : 1);
      v |= pair << (i * 2);
    }
    if (v === rom[0x3000 + x]) ok++;
  }
  return ok;
}

const results: string[] = [];
for (let D = Number(process.env.DMIN ?? 10); D <= Number(process.env.DMAX ?? 24); D++) results.push(`D=${D}: ${attempt(D)}/256`);
console.log(results.join('\n'));
