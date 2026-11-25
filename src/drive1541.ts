// Commodore 1541 disk drive: 6502 CPU, 2K RAM, DOS ROM, two 6522 VIAs, stepper, read head.
// Runs in lock-step with the C64 and talks to it over the emulated serial (IEC) bus.

import { CPU, Bus } from './cpu';
import { VIA } from './via';
import { d64ToGcr } from './gcr';

/** drive clock (1 MHz) per C64 PAL clock cycle */
export const DRIVE_PER_C64 = 1000000 / 985248;
/** drive cycles per GCR byte at each density setting (VIA2 PB5-6) */
const BYTE_CYCLES = [32, 30, 28, 26];

export interface IecLines { atn: boolean; clk: boolean; data: boolean; } // true = line pulled low

export class Drive1541 implements Bus {
  cpu: CPU;
  via1 = new VIA(); // serial bus
  via2 = new VIA(); // disk controller
  ram = new Uint8Array(2048);
  rom: Uint8Array;
  cycles = 0;          // drive clock
  private target = 0;  // drive clock the C64 has reached

  // mechanics
  halftrack = 36;      // track 18 (halftrack = track * 2)
  private stepPhase = 0;
  motor = false;
  led = false;
  private tracks: Uint8Array[] | null = null;
  private headPos = 0;          // byte index on the current track
  private nextByteAt = 0;       // drive cycle at which the next GCR byte is complete
  private prevByte = 0;
  private sync = false;
  private dataLatch = 0;

  /** C64 side of the bus, as seen by the drive */
  c64Lines: () => IecLines = () => ({ atn: false, clk: false, data: false });
  /** notify the C64 that the drive changed the lines it drives */
  onBusChanged: () => void = () => {};

  constructor(rom: Uint8Array) {
    this.rom = rom;
    this.cpu = new CPU(this);
    this.via1.readPortB = () => {
      const l = this.lines();
      return (l.data ? 0x01 : 0) | (l.clk ? 0x04 : 0) | (l.atn ? 0x80 : 0); // PB5-6 = 0: device 8
    };
    this.via1.onPortsChanged = () => this.onBusChanged();
    this.via2.readPortB = () => (this.sync ? 0 : 0x80) | 0x00; // PB4 = 0: write protected
    this.via2.readPortA = () => this.dataLatch;
    this.via2.onPortsChanged = () => this.updateMechanics();
    const irq = () => { this.cpu.irqLines = (this.via1.irq ? 1 : 0) | (this.via2.irq ? 2 : 0); };
    this.via1.onIrq = irq; this.via2.onIrq = irq;
    this.reset();
  }

  insertDisk(img: Uint8Array | null) {
    this.tracks = img ? d64ToGcr(img) : null;
    this.headPos = 0;
  }

  reset() {
    this.ram.fill(0);
    this.via1.reset(); this.via2.reset();
    this.cpu.reset();
    this.motor = false; this.led = false;
  }

  // ---- what the drive pulls on the bus ----
  get driveClk() { const o = this.via1.portBOut & this.via1.ddrb; return (o & 0x08) !== 0; }
  get driveData() { const o = this.via1.portBOut & this.via1.ddrb; return (o & 0x02) !== 0; }
  get driveAtna() { const o = this.via1.portBOut & this.via1.ddrb; return (o & 0x10) !== 0; }

  /** Combined state of the bus lines (wired-AND; true = low). */
  lines(): IecLines {
    const c = this.c64Lines();
    const atn = c.atn;
    return {
      atn,
      clk: c.clk || this.driveClk,
      // the ATN acknowledge circuit pulls DATA low while ATN and ATNA disagree
      data: c.data || this.driveData || (atn !== this.driveAtna),
    };
  }

  /** Called by the C64 when it changes ATN. */
  atnChanged() {
    this.via1.setCA1(this.c64Lines().atn);
    this.onBusChanged();
  }

  // ---- memory ----
  read(addr: number): number {
    if (addr < 0x1800) return this.ram[addr & 0x7ff];
    if (addr < 0x1c00) return this.via1.read(addr);
    if (addr < 0x2000) return this.via2.read(addr);
    if (addr >= 0x8000) return this.rom[addr & 0x3fff];
    return addr >> 8;
  }
  write(addr: number, v: number) {
    if (addr < 0x1800) { this.ram[addr & 0x7ff] = v; return; }
    if (addr < 0x1c00) { this.via1.write(addr, v); return; }
    if (addr < 0x2000) { this.via2.write(addr, v); }
  }

  private updateMechanics() {
    const pb = this.via2.portBOut;
    const phase = pb & 3;
    if (phase !== this.stepPhase) {
      const d = (phase - this.stepPhase) & 3;
      const oldTrackLen = this.currentTrack().length;
      if (d === 1 && this.halftrack < 84) this.halftrack++;
      else if (d === 3 && this.halftrack > 2) this.halftrack--;
      this.stepPhase = phase;
      const len = this.currentTrack().length;
      if (oldTrackLen && len) this.headPos = Math.floor(this.headPos * len / oldTrackLen) % len;
      else this.headPos = 0;
    }
    const motor = (pb & 0x04) !== 0;
    if (motor && !this.motor) this.nextByteAt = this.cycles + this.byteCycles();
    this.motor = motor;
    this.led = (pb & 0x08) !== 0;
  }

  private currentTrack(): Uint8Array {
    if (!this.tracks) return EMPTY;
    return this.tracks[this.halftrack >> 1] ?? EMPTY;
  }
  private byteCycles() { return BYTE_CYCLES[(this.via2.portBOut >> 5) & 3]; }

  /** One GCR byte passes under the head. */
  private rotate() {
    const track = this.currentTrack();
    if (!track.length) { this.sync = false; return; }
    const b = track[this.headPos];
    this.headPos = (this.headPos + 1) % track.length;
    const inSync = b === 0xff && this.prevByte === 0xff;
    this.prevByte = b;
    this.sync = inSync;
    if (inSync) return;
    // byte ready: latch it, flag CA1 and, if enabled, pulse the CPU's SO pin (sets V)
    const writeMode = (this.via2.pcr & 0xe0) === 0xc0;
    if (writeMode) return;
    this.dataLatch = b;
    this.via2.latchA = b;
    if ((this.via2.pcr & 0x0e) === 0x0e) this.cpu.v = 1;
    this.via2.setFlag(0x02);
  }

  /** Run the drive until its clock reaches the given C64 time (in C64 cycles). */
  runUntil(c64Cycles: number) {
    this.target = c64Cycles * DRIVE_PER_C64;
    const cpu = this.cpu;
    while (this.cycles < this.target) {
      const c = cpu.step();
      this.cycles += c;
      this.via1.clock(c);
      this.via2.clock(c);
      if (this.motor) {
        while (this.cycles >= this.nextByteAt) {
          this.rotate();
          this.nextByteAt += this.byteCycles();
        }
      }
    }
  }

  /** Re-align clocks (after the C64 resets its time base). */
  resetClock(c64Cycles: number) {
    const now = c64Cycles * DRIVE_PER_C64;
    this.nextByteAt += now - this.cycles;
    this.cycles = now;
  }
}

const EMPTY = new Uint8Array(0);
