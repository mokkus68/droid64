// Commodore 1541 disk drive: 6502 CPU, 2K RAM, DOS ROM, two 6522 VIAs, stepper, read head.
// Runs in lock-step with the C64 and talks to it over the emulated serial (IEC) bus.

import { CPU, Bus } from './cpu';
import { VIA } from './via';
import { GcrDisk, d64ToGcrDisk, gcrTrackToD64, isG64, parseG64, toG64, gcrDiskToD64 } from './gcr';

/** drive clock (1 MHz) per C64 PAL clock cycle */
export const DRIVE_PER_C64 = 1000000 / 985248;
/** drive cycles per GCR bit at each density setting (VIA2 PB5-6): 32/30/28/26 cycles per byte */
const BIT_CYCLES = [4, 3.75, 3.5, 3.25];

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
  /** the disk surface: GCR bit stream of every half track */
  gcr: GcrDisk | null = null;
  /** the disk came from a G64 file (kept as GCR) rather than a D64 (decoded back on writes) */
  isG64 = false;
  private image: Uint8Array | null = null; // D64 image updated from written tracks
  private bitPos = 0;          // bit index on the current half track
  private nextBitAt = 0;       // drive cycle at which the next bit passes under the head
  private ones = 0;            // consecutive 1 bits (10 or more = SYNC)
  private shift = 0;           // read shift register
  private bitCount = 0;        // bits since the last byte boundary
  private writeShift = 0;
  private sync = false;
  private dataLatch = 0;
  private dirty = new Set<number>();   // half tracks written since the last flush
  private writing = false;
  /** written data has been stored (D64 sectors decoded, or the G64 surface changed) */
  onDiskWritten: () => void = () => {};

  /** C64 side of the bus, as seen by the drive */
  c64Lines: () => IecLines = () => ({ atn: false, clk: false, data: false });
  /** notify the C64 that the drive changed the lines it drives */
  onBusChanged: () => void = () => {};

  constructor(rom: Uint8Array, public device = 8) {
    this.rom = rom;
    this.cpu = new CPU(this);
    this.via1.readPortB = () => {
      const l = this.lines();
      // PB5-6: device number jumpers (00 = 8, 01 = 9)
      return (l.data ? 0x01 : 0) | (l.clk ? 0x04 : 0) | (((this.device - 8) & 3) << 5) | (l.atn ? 0x80 : 0);
    };
    this.via1.onPortsChanged = () => this.onBusChanged();
    // PB4 = write-protect sensor (1 = writable), PB7 = SYNC (0 = sync mark under the head)
    this.via2.readPortB = () => (this.sync ? 0 : 0x80) | (this.gcr ? 0x10 : 0);
    this.via2.readPortA = () => this.dataLatch;
    this.via2.onPortsChanged = () => this.updateMechanics();
    const irq = () => { this.cpu.irqLines = (this.via1.irq ? 1 : 0) | (this.via2.irq ? 2 : 0); };
    this.via1.onIrq = irq; this.via2.onIrq = irq;
    this.reset();
  }

  /** Insert a D64 or G64 image (null = no disk). */
  insertDisk(img: Uint8Array | null) {
    this.flushWrites();
    this.isG64 = !!img && isG64(img);
    this.image = img && !this.isG64 ? img : null;
    this.gcr = img ? (this.isG64 ? parseG64(img) : d64ToGcrDisk(img)) : null;
    this.bitPos = 0;
    this.dirty.clear();
  }

  /** Store what the DOS wrote: decode D64 sectors, or just report the changed G64 surface. */
  flushWrites() {
    if (!this.dirty.size || !this.gcr) { this.dirty.clear(); return; }
    let changed = this.isG64;
    if (this.image) {
      for (const ht of this.dirty) {
        const tr = this.gcr.tracks[ht];
        if (tr && !(ht & 1)) changed = gcrTrackToD64(tr, ht >> 1, this.image, this.gcr.bits[ht]) > 0 || changed;
      }
    }
    this.dirty.clear();
    if (changed) this.onDiskWritten();
  }

  /** The disk surface as a G64 file. */
  exportG64(): Uint8Array | null { return this.gcr ? toG64(this.gcr) : null; }
  /** The disk contents decoded into a D64 (for directory listings of G64 disks). */
  decodedD64(): Uint8Array | null { return this.gcr ? gcrDiskToD64(this.gcr) : null; }

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
  /** What this drive pulls low on the bus, given the ATN level. */
  pulls(atn: boolean) {
    // the ATN acknowledge circuit pulls DATA low while ATN and ATNA disagree
    return { clk: this.driveClk, data: this.driveData || (atn !== this.driveAtna) };
  }

  /** other drives on the same bus (set by the machine) */
  otherPulls: (atn: boolean) => { clk: boolean; data: boolean } = () => ({ clk: false, data: false });

  lines(): IecLines {
    const c = this.c64Lines();
    const atn = c.atn;
    const own = this.pulls(atn), other = this.otherPulls(atn);
    return { atn, clk: c.clk || own.clk || other.clk, data: c.data || own.data || other.data };
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
      const oldBits = this.trackBits();
      if (d === 1 && this.halftrack < 84) this.halftrack++;
      else if (d === 3 && this.halftrack > 2) this.halftrack--;
      this.stepPhase = phase;
      const bits = this.trackBits();
      // the disk keeps spinning: keep the same angular position on the new track
      this.bitPos = oldBits && bits ? Math.floor(this.bitPos * bits / oldBits) % bits : 0;
    }
    const writing = (this.via2.pcr & 0xe0) === 0xc0;
    if (writing !== this.writing) this.bitCount = 0;
    if (this.writing && !writing) this.flushWrites();
    this.writing = writing;
    const motor = (pb & 0x04) !== 0;
    if (!motor && this.motor) this.flushWrites();
    if (motor && !this.motor) this.nextBitAt = this.cycles + this.bitCycles();
    this.motor = motor;
    this.led = (pb & 0x08) !== 0;
  }

  private trackBits() { return this.gcr ? this.gcr.bits[this.halftrack] : 0; }
  private bitCycles() { return BIT_CYCLES[(this.via2.portBOut >> 5) & 3]; }

  private byteReady(b: number) {
    // latch the byte, flag CA1 and, if enabled, pulse the CPU's SO pin (sets V)
    this.dataLatch = b;
    this.via2.latchA = b;
    if ((this.via2.pcr & 0x0e) === 0x0e) this.cpu.v = 1;
    this.via2.setFlag(0x02);
  }

  /** One bit cell passes under the head. */
  private rotateBit() {
    const gcr = this.gcr;
    const ht = this.halftrack;
    const track = gcr?.tracks[ht];
    const bits = gcr ? gcr.bits[ht] : 0;
    if (this.writing) {
      // write mode: the byte in VIA2 port A is shifted out MSB first; byte-ready marks each load
      if (this.bitCount === 0) this.writeShift = this.via2.portAOut;
      const bit = (this.writeShift >> 7) & 1;
      this.writeShift = (this.writeShift << 1) & 0xff;
      if (track && bits) {
        const i = this.bitPos;
        if (bit) track[i >> 3] |= 0x80 >> (i & 7); else track[i >> 3] &= ~(0x80 >> (i & 7));
        this.bitPos = (i + 1) % bits;
        this.dirty.add(ht);
      }
      this.sync = false; this.ones = 0;
      if (++this.bitCount === 8) { this.bitCount = 0; this.byteReady(this.via2.portAOut); }
      return;
    }
    let bit = 0;
    if (track && bits) {
      const i = this.bitPos;
      bit = (track[i >> 3] >> (7 - (i & 7))) & 1;
      this.bitPos = (i + 1) % bits;
    }
    this.ones = bit ? this.ones + 1 : 0;
    this.sync = this.ones >= 10;
    if (this.sync) { this.bitCount = 0; return; } // the byte counter is held while in SYNC
    this.shift = ((this.shift << 1) | bit) & 0xff;
    if (++this.bitCount === 8) { this.bitCount = 0; this.byteReady(this.shift); }
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
        while (this.cycles >= this.nextBitAt) {
          this.rotateBit();
          this.nextBitAt += this.bitCycles();
        }
      }
    }
  }

  /** Re-align clocks (after the C64 resets its time base). */
  resetClock(c64Cycles: number) {
    const now = c64Cycles * DRIVE_PER_C64;
    this.nextBitAt += now - this.cycles;
    this.cycles = now;
  }
}

