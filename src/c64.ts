// The C64 machine: memory map, chip wiring, frame loop and program loading

import { CPU, Bus } from './cpu';
import { VIC, CYCLES_PER_LINE, LINES_PER_FRAME } from './vic';
import { SID } from './sid';
import { CIA } from './cia';
import { D64File, DiskImage, matchName, buildDirectoryListing, parseD64 } from './media';
import { Cartridge } from './cartridge';
import { VirtualDrive } from './vdrive';
import { Drive1541 } from './drive1541';
import { isG64 } from './gcr';
import { capture, restore } from './snapshot';
import { Tape } from './tape';
import { REU } from './reu';

export interface Roms { basic: Uint8Array; kernal: Uint8Array; chargen: Uint8Array; }

const T_SAVE = 9, T_LOAD = 0, T_LISTEN = 1, T_TALK = 2, T_SECOND = 3, T_TKSA = 4, T_CIOUT = 5, T_ACPTR = 6, T_UNTLK = 7, T_UNLSN = 8;
const M_RAM = 0, M_BASIC = 1, M_KERNAL = 2, M_IO = 3, M_CHAR = 4, M_ROML = 5, M_ROMH = 6, M_OPEN = 7;

export const JOY_UP = 1, JOY_DOWN = 2, JOY_LEFT = 4, JOY_RIGHT = 8, JOY_FIRE = 16;
export const CLOCK_HZ = 985248;
export const FRAME_HZ = CLOCK_HZ / (CYCLES_PER_LINE * LINES_PER_FRAME);

export class C64 implements Bus {
  ram = new Uint8Array(65536);
  colorRam = new Uint8Array(1024);
  cpu: CPU;
  vic: VIC;
  sid: SID;
  cia1 = new CIA();
  cia2 = new CIA();
  roms: Roms;

  /** keyboard matrix: keys[column] = bitmask of pressed rows */
  keys = new Uint8Array(8);
  joy1 = 0; joy2 = 0;

  // processor port
  private portDdr = 0x2f; private portData = 0x37;
  // memory map: what the CPU sees in each 4K page
  private map = new Uint8Array(16);
  private ultimax = false;
  cart: Cartridge | null = null;
  private vicBank = 0;
  private cycleBudget = 0;
  frameCount = 0;

  private typeQueue: number[] = [];
  disk: (DiskImage & { files: D64File[] }) | null = null;
  onDiskLoad: ((name: string, ok: boolean, start?: number) => void) | null = null;

  constructor(roms: Roms, sampleRate = 44100) {
    this.roms = roms;
    this.cpu = new CPU(this);
    this.sid = new SID(sampleRate);
    this.vic = new VIC({
      vicRead: (a: number) => {
        a &= 0x3fff;
        if (this.ultimax) {
          // in Ultimax mode the VIC sees the cartridge ROMH at $3000-$3FFF of every bank
          if ((a & 0x3000) === 0x3000 && this.cart) return this.cart.readRomh(a | 0x1000);
        } else if ((this.vicBank & 1) === 0 && (a & 0x3000) === 0x1000) return this.roms.chargen[a & 0xfff];
        return this.ram[(this.vicBank << 14) | a];
      },
      colorRam: this.colorRam,
    });
    this.vic.onIrq = (on) => { if (on) this.cpu.irqLines |= 1; else this.cpu.irqLines &= ~1; };
    this.cia1.onIrq = (on) => { if (on) this.cpu.irqLines |= 2; else this.cpu.irqLines &= ~2; };
    this.cia2.onIrq = (on) => this.cpu.setNMI(on);

    // CIA1: keyboard + joysticks
    this.cia1.readPortA = (c) => {
      let v = (c.pra | ~c.ddra) & 0xff;
      const pb = (c.prb | ~c.ddrb) & ~this.portBits(1) & 0xff;
      // reverse scan: rows driven low pull columns low
      for (let col = 0; col < 8; col++) if (this.keys[col] & ~pb) v &= ~(1 << col);
      return v & ~this.portBits(2);
    };
    this.cia1.readPortB = (c) => {
      let v = (c.prb | ~c.ddrb) & 0xff;
      const pa = (c.pra | ~c.ddra) & ~this.portBits(2) & 0xff;
      for (let col = 0; col < 8; col++) if (!(pa & (1 << col))) v &= ~this.keys[col];
      return v & ~this.portBits(1);
    };
    // CIA2: VIC bank + serial bus (no devices attached: lines read back as released)
    this.cia2.readPortA = (c) => {
      const out = (c.pra | ~c.ddra) & 0xff;
      if (this.drive) {
        const l = this.busLines();
        return (out & 0x3f) | (l.clk ? 0 : 0x40) | (l.data ? 0 : 0x80);
      }
      const clkIn = out & 0x10 ? 0 : 0x40;
      const dataIn = out & 0x20 ? 0 : 0x80;
      return (out & 0x3f) | clkIn | dataIn;
    };
    this.cia2.readPortB = () => 0xff;
    this.cia2.writePorts = (c) => { this.vicBank = 3 - ((c.pra | ~c.ddra) & 3); };
    this.reset();
  }

  reset() {
    // RAM power-up pattern
    for (let i = 0; i < 65536; i++) this.ram[i] = (i & 0x40) ? 0xff : 0x00;
    this.colorRam.fill(0);
    this.cart?.reset();
    this.reu?.reset();
    this.vdrive?.reset();
    this.vdrive9?.reset();
    for (const d of this.realDrives()) { d.reset(); d.resetClock(this.now); }
    this.portDdr = 0x2f; this.portData = 0x37; this.updatePort();
    this.cia1.reset(); this.cia2.reset();
    this.vicBank = 0;
    this.vic.reset(); this.sid.reset();
    this.keys.fill(0);
    this.cpu.irqLines = 0;
    this.typeQueue = [];
    this.cpu.reset();
    this.frameCount = 0;
  }

  /** Rebuild the CPU memory map from the processor port and the cartridge EXROM/GAME lines (PLA logic). */
  private updatePort() {
    // cassette motor: bit 5 output low = motor on; bit 3 = cassette write line
    if (this.tape) {
      const motor = (this.portDdr & 0x20) !== 0 && (this.portData & 0x20) === 0;
      if (this.tape.motor && !motor) this.tape.commit();
      this.tape.motor = motor;
      this.tape.writeLine(this.portData & this.portDdr & 0x08, this.instrStart + 3);
    }
    const bits = (this.portData | ~this.portDdr) & 7;
    const lo = bits & 1, hi = bits & 2, ch = bits & 4;
    const exrom = this.cart ? this.cart.exrom : 1;
    const game = this.cart ? this.cart.game : 1;
    const m = this.map;
    m.fill(M_RAM);
    this.ultimax = game === 0 && exrom === 1;
    if (this.ultimax) {
      for (let p = 1; p < 16; p++) m[p] = M_OPEN;
      m[0x8] = m[0x9] = M_ROML;
      m[0xd] = M_IO;
      m[0xe] = m[0xf] = M_ROMH;
      return;
    }
    if (lo && hi) {
      if (exrom === 0) { m[0x8] = m[0x9] = M_ROML; }
      if (exrom === 0 && game === 0) { m[0xa] = m[0xb] = M_ROMH; }
      else { m[0xa] = m[0xb] = M_BASIC; }
    } else if (hi && exrom === 0 && game === 0) {
      m[0xa] = m[0xb] = M_ROMH;
    }
    if (hi) m[0xe] = m[0xf] = M_KERNAL;
    if (lo || hi) m[0xd] = ch ? M_IO : M_CHAR;
  }

  get kernalIn() { return this.map[0xf] === M_KERNAL; }

  read(addr: number): number {
    if (addr < 2) {
      if (addr === 0) return this.portDdr;
      const sense = this.tape?.playing ? 0 : 0x10; // cassette switch sense: 0 = a key is pressed
      return (this.portData & this.portDdr) | (~this.portDdr & (0x07 | sense));
    }
    switch (this.map[addr >> 12]) {
      case M_RAM: return this.ram[addr];
      case M_BASIC: return this.roms.basic[addr & 0x1fff];
      case M_KERNAL: return this.roms.kernal[addr & 0x1fff];
      case M_IO: return this.ioRead(addr);
      case M_CHAR: return this.roms.chargen[addr & 0xfff];
      case M_ROML: return this.cart!.readRoml(addr);
      case M_ROMH: return this.cart!.readRomh(addr);
      default: return 0xff; // Ultimax: unmapped
    }
  }

  write(addr: number, v: number) {
    if (addr < 2) {
      if (addr === 0) this.portDdr = v; else this.portData = v;
      this.ram[addr] = v;
      this.updatePort();
      return;
    }
    const t = this.map[addr >> 12];
    if (t === M_IO) { this.ioWrite(addr, v); return; }
    if (addr === 0xff00 && this.reu) { this.reu.ff00Written(); this.takeDmaStall(); }
    if ((t === M_ROML || t === M_ROMH) && this.cart!.writeRom(addr, v)) return;
    if (this.ultimax && t !== M_RAM) return; // cartridge ROM / open bus in Ultimax mode
    this.ram[addr] = v;
  }

  /** Insert (or remove with null) a cartridge; the machine is reset. */
  insertCartridge(cart: Cartridge | null) {
    this.cart = cart;
    if (cart) {
      cart.onLinesChanged = () => this.updatePort();
      cart.onNmi = () => this.cpu.triggerNMI();
    }
    this.reset();
  }

  private ioRead(addr: number): number {
    switch ((addr >> 8) & 0xf) {
      case 0: case 1: case 2: case 3: return this.vic.read(addr);
      case 4: case 5: case 6: case 7: {
        const r = addr & 0x1f;
        if (r === 0x19 || r === 0x1a) return this.readPot(r === 0x19 ? 0 : 1);
        return this.sid.read(addr);
      }
      case 8: case 9: case 0xa: case 0xb: return (this.colorRam[addr & 0x3ff] & 0x0f) | 0xf0;
      case 0xc: return this.cia1.read(addr);
      case 0xd:
        if (this.drive && (addr & 0xf) === 0) this.syncDrives(this.instrStart + 3);
        return this.cia2.read(addr);
      case 0xe: return this.cart ? this.cart.io1Read(addr) : 0xff;
      default:
        if (this.reu) return this.reu.read(addr);
        return this.cart ? this.cart.io2Read(addr) : 0xff;
    }
  }

  private ioWrite(addr: number, v: number) {
    switch ((addr >> 8) & 0xf) {
      case 0: case 1: case 2: case 3: this.vic.write(addr, v); break;
      case 4: case 5: case 6: case 7: this.sid.write(addr, v); break;
      case 8: case 9: case 0xa: case 0xb: this.colorRam[addr & 0x3ff] = v & 0x0f; break;
      case 0xc: this.cia1.write(addr, v); break;
      case 0xd: {
        const r = addr & 0xf;
        if (this.drive && (r === 0 || r === 2)) {
          this.syncDrives(this.instrStart + 3);
          const atn = this.iecLines().atn;
          this.cia2.write(addr, v);
          if (this.iecLines().atn !== atn) for (const d of this.realDrives()) d.atnChanged();
        } else this.cia2.write(addr, v);
        break;
      }
      case 0xe: this.cart?.io1Write(addr, v); break;
      case 0xf:
        if (this.reu) { this.reu.write(addr, v); this.takeDmaStall(); }
        else this.cart?.io2Write(addr, v);
        break;
    }
  }

  /** Run one full video frame (312 raster lines). */
  runFrame() {
    const cpu = this.cpu, vic = this.vic, cia1 = this.cia1, cia2 = this.cia2, sid = this.sid;
    for (let line = 0; line < LINES_PER_FRAME; line++) {
      const stolen = vic.startLine();
      if (stolen) { cia1.clock(stolen); cia2.clock(stolen); if (this.tape?.playing && this.tape.motor) this.tape.clock(stolen); }
      this.cycleBudget += CYCLES_PER_LINE - stolen;
      this.now += stolen;
      const drive = this.drive, drive9 = this.drive9;
      const tape = this.tape && this.tape.playing && this.tape.motor ? this.tape : null; // also counts while recording
      while (this.cycleBudget > 0) {
        this.instrStart = this.now;
        const c = cpu.step();
        this.cycleBudget -= c;
        this.now += c;
        cia1.clock(c); cia2.clock(c);
        if (drive) { drive.runUntil(this.now); if (drive9) drive9.runUntil(this.now); }
        if (tape) tape.clock(c);
      }
      sid.clock(CYCLES_PER_LINE);
      vic.endLine();
    }
    cia1.tickTOD(); cia2.tickTOD();
    this.frameCount++;
    this.feedKeyboardBuffer();
  }

  /** NMI from the RESTORE key */
  restore() { this.cpu.triggerNMI(); }

  // ---------- typing via the KERNAL keyboard buffer ----------
  typeText(text: string) {
    for (const ch of text.replace(/\r\n?/g, '\n')) {
      const code = asciiToPetscii(ch);
      if (code >= 0) this.typeQueue.push(code);
    }
  }
  get isTyping() { return this.typeQueue.length > 0; }

  private feedKeyboardBuffer() {
    if (!this.typeQueue.length) return;
    if (this.ram[0xc6] !== 0) return;
    let n = 0;
    while (n < 9 && this.typeQueue.length) {
      const c = this.typeQueue.shift()!;
      this.ram[0x277 + n++] = c;
      if (c === 13) break; // let BASIC process each line
    }
    this.ram[0xc6] = n;
  }

  // ---------- program loading ----------
  /** Copy a PRG into memory, fix up BASIC pointers. Returns load range. */
  injectPrg(data: Uint8Array): { start: number; end: number } {
    const start = data[0] | (data[1] << 8);
    const body = data.subarray(2);
    const len = Math.min(body.length, 0x10000 - start);
    this.ram.set(body.subarray(0, len), start);
    const end = start + len;
    if (start === 0x0801 || start === 0x0401) {
      for (const p of [0x2d, 0x2f, 0x31]) { this.ram[p] = end & 0xff; this.ram[p + 1] = end >> 8; }
    }
    this.ram[0xae] = end & 0xff; this.ram[0xaf] = end >> 8;
    return { start, end };
  }

  /** Reset, boot to READY, inject the program and start it. */
  loadAndRun(data: Uint8Array) {
    this.reset();
    for (let i = 0; i < 160; i++) this.runFrame(); // boot to READY.
    this.sid.readPos = this.sid.writePos;
    const { start } = this.injectPrg(data);
    this.typeText(start === 0x0801 ? 'RUN\n' : `SYS${start}\n`);
  }

  vdrive: VirtualDrive | null = null;
  onDriveActivity: ((device: number) => void) | null = null;
  onFastloader: (() => void) | null = null;
  /** result of a KERNAL SAVE served by the virtual drive (DOS status code) */
  onDiskSave: ((name: string, code: number, device: number) => void) | null = null;
  /** the mounted disk image was written to */
  onDiskChanged: ((device: number) => void) | null = null;
  private traps = new Map<number, number>();
  /** true when the full virtual drive (OPEN, GET#, command channel…) is active, not just LOAD */
  serialTrapsActive = false;

  // ---------- control port devices: mouse 1351 and paddles ----------
  /** what is plugged into control ports 1 and 2 (index 1 and 2) */
  portDevice: ('joystick' | 'mouse' | 'paddle')[] = ['joystick', 'joystick', 'joystick'];
  mouseX = 0; mouseY = 0;           // accumulated mouse position (1351 counts)
  mouseButtons = 0;                 // bit 0 left, bit 1 right
  paddle = [128, 128];              // paddle 1 and 2 positions (0-255)
  paddleButtons = 0;                // bit 0 paddle 1, bit 1 paddle 2

  /** Joystick-line bits (active high) for a port: joystick plus mouse/paddle buttons. */
  private portBits(port: 1 | 2): number {
    let v = port === 1 ? this.joy1 : this.joy2;
    const dev = this.portDevice[port];
    if (dev === 'mouse') v |= (this.mouseButtons & 1 ? 0x10 : 0) | (this.mouseButtons & 2 ? 0x01 : 0);
    else if (dev === 'paddle') v |= (this.paddleButtons & 1 ? 0x04 : 0) | (this.paddleButtons & 2 ? 0x08 : 0);
    return v;
  }

  /** SID POTX/POTY: CIA1 port A bits 6/7 choose which control port is connected. */
  private readPot(axis: 0 | 1): number {
    const pa = (this.cia1.pra | ~this.cia1.ddra) & 0xff;
    const port = pa & 0x40 ? 1 : pa & 0x80 ? 2 : 0;
    if (!port) return 0xff;
    const dev = this.portDevice[port];
    if (dev === 'mouse') {
      // 1351 proportional mode: position modulo 64 in bits 1-6; Y grows when moving up
      const pos = axis === 0 ? this.mouseX : -this.mouseY;
      return (pos << 1) & 0x7e;
    }
    if (dev === 'paddle') return this.paddle[axis] & 0xff;
    return 0xff;
  }

  // ---------- RAM Expansion Unit ----------
  reu: REU | null = null;
  /** Plug in a REU of the given size in KB (128, 256 or 512), or remove it with 0. */
  setReu(sizeKB: number) {
    this.reu = sizeKB ? new REU(sizeKB, { read: (a) => this.read(a), write: (a, v) => this.write(a, v) }) : null;
    if (this.reu) this.reu.onIrq = (on) => { if (on) this.cpu.irqLines |= 8; else this.cpu.irqLines &= ~8; };
    else this.cpu.irqLines &= ~8;
  }
  /** DMA halts the CPU: charge the transfer time to the current line's cycle budget. */
  private takeDmaStall() {
    const n = this.reu!.stall;
    if (!n) return;
    this.reu!.stall = 0;
    this.cycleBudget -= n;
    this.now += n;
    this.cia1.clock(n); this.cia2.clock(n);
  }

  // ---------- cassette ----------
  tape: Tape | null = null;
  insertTape(tape: Tape | null) {
    this.tape = tape;
    if (tape) tape.onEdge = () => this.cia1.flag();
    this.updatePort();
  }

  // ---------- drives 8 and 9: fast virtual drives or emulated 1541s ----------
  drive: Drive1541 | null = null;     // emulated 1541 on device 8
  drive9: Drive1541 | null = null;    // emulated 1541 on device 9
  vdrive9: VirtualDrive | null = null;
  disk9: (DiskImage & { files: D64File[] }) | null = null;
  private diskImage9: Uint8Array | null = null;
  /** a second drive (device 9) is connected */
  drive9Enabled = false;
  private driveRom: Uint8Array | null = null;
  private now = 0;          // C64 cycles since power-on, including cycles stolen by the VIC
  private instrStart = 0;   // C64 time at the start of the current instruction
  private diskImage: Uint8Array | null = null;

  /** C64 outputs on the serial bus (true = line pulled low). */
  iecLines() {
    const c = this.cia2, o = c.pra & c.ddra;
    return { atn: (o & 0x08) !== 0, clk: (o & 0x10) !== 0, data: (o & 0x20) !== 0 };
  }
  private realDrives(): Drive1541[] {
    return this.drive9 ? [this.drive!, this.drive9] : this.drive ? [this.drive] : [];
  }
  /** Wired-AND of the C64 and every emulated drive. */
  private busLines() {
    const c = this.iecLines();
    let clk = c.clk, data = c.data;
    for (const d of this.realDrives()) { const p = d.pulls(c.atn); clk ||= p.clk; data ||= p.data; }
    return { atn: c.atn, clk, data };
  }
  private syncDrives(t: number) { for (const d of this.realDrives()) d.runUntil(t); }

  private makeDrive(rom: Uint8Array, device: number, image: Uint8Array | null): Drive1541 {
    const d = new Drive1541(rom, device);
    d.c64Lines = () => this.iecLines();
    d.otherPulls = (atn) => {
      let clk = false, data = false;
      for (const o of this.realDrives()) if (o !== d) { const p = o.pulls(atn); clk ||= p.clk; data ||= p.data; }
      return { clk, data };
    };
    d.onDiskWritten = () => {
      // a G64 stays as GCR: its listing comes from decoding the surface
      const listing = d.isG64 ? d.decodedD64() : device === 9 ? this.diskImage9 : this.diskImage;
      if (listing) { const p = parseD64(listing); if (device === 9) this.disk9 = p; else this.disk = p; }
      this.onDiskChanged?.(device);
    };
    d.resetClock(this.now);
    d.insertDisk(image);
    return d;
  }

  /** Attach fully emulated 1541s (pass the 16K DOS ROM) or go back to the fast virtual drives (null). */
  attachDrive(rom: Uint8Array | null) {
    this.driveRom = rom;
    this.drive = rom ? this.makeDrive(rom, 8, this.diskImage) : null;
    this.drive9 = rom && this.drive9Enabled ? this.makeDrive(rom, 9, this.diskImage9) : null;
    this.mountDisk(this.disk, this.diskImage, true);
    this.mountDisk(this.disk9, this.diskImage9, true, 9);
  }

  // ---------- snapshots ----------
  /** fields never saved: ROMs, media (saved separately), back references, audio buffer, picture */
  private static SKIP = new Set(['roms', 'cart', 'disk', 'disk9', 'diskImage', 'diskImage9', 'vdrive', 'vdrive9',
    'drive', 'drive9', 'tape', 'traps', 'driveRom', 'activeV', 'bus', 'mem', 'frameBuffer', 'buffer', 'rom', 'gcr', 'image', 'dirty', 'lo', 'hi', 'source', 'rec', 'done']);

  /** Machine state (media excluded: they are mounted again before restoring). */
  saveState() {
    this.drive?.flushWrites(); this.drive9?.flushWrites();
    const skip = C64.SKIP;
    return {
      c64: capture(this, skip),
      drive8: this.drive ? capture(this.drive, skip) : null,
      drive9: this.drive9 ? capture(this.drive9, skip) : null,
      cart: this.cart ? capture(this.cart, skip) : null,
    };
  }

  /** Restore a state saved by saveState() into a machine with the same configuration and media. */
  loadState(st: { c64: any; drive8: any; drive9: any; cart: any }) {
    restore(this, st.c64);
    if (st.drive8 && this.drive) restore(this.drive, st.drive8);
    if (st.drive9 && this.drive9) restore(this.drive9, st.drive9);
    if (st.cart && this.cart) restore(this.cart, st.cart);
    // rebuild what is derived from the restored registers
    this.updatePort();
    this.buildTraps();
    this.updateTrap();
    this.sid.readPos = this.sid.writePos;
  }

  /** The current image of a drive: for a G64 in an emulated 1541, the surface as written so far. */
  currentImage(device: 8 | 9 = 8): Uint8Array | null {
    const d = device === 9 ? this.drive9 : this.drive;
    if (d?.isG64) return d.exportG64();
    return device === 9 ? this.diskImage9 : this.diskImage;
  }

  /** Connect or disconnect the second drive (device 9). */
  enableDrive9(on: boolean) {
    this.drive9Enabled = on;
    if (!on) { this.disk9 = null; this.diskImage9 = null; this.vdrive9 = null; this.drive9 = null; this.updateTrap(); return; }
    if (this.driveRom && !this.drive9) this.drive9 = this.makeDrive(this.driveRom, 9, this.diskImage9);
  }

  mountDisk(disk: (DiskImage & { files: D64File[] }) | null, image: Uint8Array | null = null, force = false, device: 8 | 9 = 8) {
    const nine = device === 9;
    const real = nine ? this.drive9 : this.drive;
    if (real) {
      // the emulated drive reads the disk itself: no KERNAL traps
      if (force || image !== (nine ? this.diskImage9 : this.diskImage)) real.insertDisk(image);
      if (nine) { this.disk9 = disk; this.diskImage9 = image; this.vdrive9 = null; }
      else { this.disk = disk; this.diskImage = image; this.vdrive = null; }
      this.updateTrap();
      return;
    }
    if (nine && !this.drive9Enabled) return;
    const cur = nine ? this.vdrive9 : this.vdrive;
    if (nine) this.diskImage9 = image; else this.diskImage = image;
    if (!force && disk && (nine ? this.disk9 : this.disk) === disk && cur) { this.updateTrap(); return; }
    // a G64 is raw GCR: the virtual drive serves it read-only from its decoded listing
    const v = disk ? new VirtualDrive(disk, image && isG64(image) ? null : image, device) : null;
    if (v) {
      v.onActivity = () => this.onDriveActivity?.(device);
      v.onFastloader = () => this.onFastloader?.();
      v.onDiskChanged = () => {
        if (nine) this.disk9 = v.disk; else this.disk = v.disk;
        this.onDiskChanged?.(device);
      };
    }
    if (nine) { this.disk9 = disk; this.vdrive9 = v; } else { this.disk = disk; this.vdrive = v; }
    this.buildTraps();
    this.updateTrap();
  }

  /** KERNAL traps are needed while a virtual drive has a disk. */
  private updateTrap() {
    this.cpu.trap = this.vdrive || this.vdrive9 ? (cpu) => this.kernalTrap(cpu) : null;
  }

  /** Trap the KERNAL serial-bus routines: both the jump-table entries and the routines they jump to. */
  private buildTraps() {
    this.traps.clear();
    const k = this.roms.kernal;
    const entries: [number, number][] = [
      [0xffb1, T_LISTEN], [0xffb4, T_TALK], [0xff93, T_SECOND], [0xff96, T_TKSA],
      [0xffa8, T_CIOUT], [0xffa5, T_ACPTR], [0xffab, T_UNTLK], [0xffae, T_UNLSN],
    ];
    // Only a KERNAL laid out like the Commodore one (901227-xx) routes OPEN/CHKIN/CLOSE through
    // these routines; other KERNALs (e.g. the free Open ROMs) keep just the LOAD trap.
    const ORIGINAL: Record<number, number> = { 0xffb1: 0xed0c, 0xffb4: 0xed09, 0xff93: 0xedb9, 0xff96: 0xedc7, 0xffa8: 0xeddd, 0xffa5: 0xee13, 0xffab: 0xedef, 0xffae: 0xedfe };
    const target = (a: number) => (k[a - 0xe000] === 0x4c ? k[a - 0xe000 + 1] | (k[a - 0xe000 + 2] << 8) : -1);
    this.serialTrapsActive = entries.every(([a]) => target(a) === ORIGINAL[a]);
    if (this.serialTrapsActive) {
      for (const [addr, kind] of entries) {
        this.traps.set(addr, kind);
        this.traps.set(target(addr), kind);
      }
    }
    this.traps.set(0xffd5, T_LOAD);
    this.traps.set(0xffd8, T_SAVE);
  }

  /** Intercept KERNAL LOAD ($FFD5) for device 8 and serve files from the mounted image. */
  private rts(cpu: CPU) {
    const lo = this.read(0x100 | ((cpu.s + 1) & 0xff)), hi = this.read(0x100 | ((cpu.s + 2) & 0xff));
    cpu.s = (cpu.s + 2) & 0xff;
    cpu.pc = (((hi << 8) | lo) + 1) & 0xffff;
  }

  private activeV: VirtualDrive | null = null;
  private serialTrap(cpu: CPU, kind: number): boolean {
    if (kind === T_LISTEN || kind === T_TALK) {
      const dev = cpu.a & 0x1f;
      const v = dev === 9 ? this.vdrive9 : dev === 8 ? this.vdrive : null;
      for (const o of [this.vdrive, this.vdrive9]) if (o && o !== v) { o.listen(0); o.talk(0); }
      this.activeV = v;
      if (!v) return false;
      if (kind === T_LISTEN) v.listen(cpu.a); else v.talk(cpu.a);
      cpu.c = 0; this.rts(cpu);
      return true;
    }
    const d = this.activeV;
    if (!d) return false;
    switch (kind) {
      case T_SECOND: if (!d.active) return false; d.second(cpu.a); break;
      case T_TKSA: if (!d.active) return false; d.tksa(cpu.a); break;
      case T_CIOUT: if (!d.active) return false; d.ciout(cpu.a); break;
      case T_UNLSN: if (!d.active) return false; d.unlisten(); break;
      case T_UNTLK: if (!d.active) return false; d.untalk(); break;
      case T_ACPTR: {
        if (!d.active) return false;
        const [b, st] = d.acptr();
        cpu.a = b; cpu.z = b === 0 ? 1 : 0; cpu.n = b >> 7;
        this.ram[0x90] |= st;
        break;
      }
    }
    cpu.c = 0;
    this.rts(cpu);
    return true;
  }

  /** KERNAL SAVE ($FFD8): A = zero-page pointer to the start address, X/Y = end address. */
  private saveTrap(cpu: CPU): boolean {
    const ram = this.ram;
    const dev = ram[0xba];
    const vd = dev === 9 ? this.vdrive9 : dev === 8 ? this.vdrive : null;
    if (!vd) return false;
    const zp = cpu.a;
    const start = ram[zp] | (ram[(zp + 1) & 0xff] << 8);
    const end = cpu.x | (cpu.y << 8);
    const nameLen = ram[0xb7], nameAddr = ram[0xbb] | (ram[0xbc] << 8);
    const name = new Uint8Array(nameLen);
    for (let i = 0; i < nameLen; i++) name[i] = this.read((nameAddr + i) & 0xffff);
    const data = new Uint8Array(Math.max(0, end - start) + 2);
    data[0] = start & 0xff; data[1] = start >> 8;
    for (let a = start, i = 2; a < end; a++, i++) data[i] = this.read(a);
    this.onDriveActivity?.(dev);
    const code = vd.saveFile(name, data, 'PRG');
    this.rts(cpu);
    // as on a real 1541, disk errors (file exists, disk full) are not reported by SAVE itself:
    // they are in the drive status (PRINT DS$ / INPUT#15)
    cpu.c = 0; cpu.a = 0;
    ram[0x90] = 0;
    this.onDiskSave?.(Array.from(name, (c) => String.fromCharCode(c)).join(''), code, dev);
    return true;
  }

  private kernalTrap(cpu: CPU): boolean {
    const kind = this.traps.get(cpu.pc);
    if (kind === undefined || cpu.pc < 0xe000 || !this.kernalIn) return false;
    if (kind === T_SAVE) return this.saveTrap(cpu);
    if (kind !== T_LOAD) return this.serialTrap(cpu, kind);
    const ram = this.ram;
    const dev = ram[0xba];
    const ldisk = dev === 9 ? (this.vdrive9 ? this.disk9 : null) : dev === 8 ? (this.vdrive ? this.disk : null) : null;
    if (!ldisk) return false;
    const nameLen = ram[0xb7];
    const nameAddr = ram[0xbb] | (ram[0xbc] << 8);
    const name = new Uint8Array(nameLen);
    for (let i = 0; i < nameLen; i++) name[i] = this.read((nameAddr + i) & 0xffff);
    const sa = ram[0xb9];
    let data: Uint8Array | null = null;
    let label = Array.from(name, (c) => String.fromCharCode(c)).join('');
    if (nameLen >= 1 && name[0] === 0x24) {
      data = buildDirectoryListing(ldisk);
    } else {
      // "0:NAME" drive prefix
      let pat = name;
      const colon = pat.indexOf(0x3a);
      if (colon >= 0 && colon <= 1) pat = pat.subarray(colon + 1);
      const file = ldisk.files.find((f) => f.data && f.type === 'PRG' && (pat.length === 0 || matchName(pat, f.rawName)));
      if (file) { data = file.data; label = file.name; }
    }
    this.onDriveActivity?.(dev);
    // emulate RTS from the JSR $FFD5
    const lo = this.read(0x100 | ((cpu.s + 1) & 0xff)), hi = this.read(0x100 | ((cpu.s + 2) & 0xff));
    cpu.s = (cpu.s + 2) & 0xff;
    cpu.pc = (((hi << 8) | lo) + 1) & 0xffff;
    if (!data || data.length < 2) {
      cpu.c = 1; cpu.a = 4; // FILE NOT FOUND
      this.onDiskLoad?.(label, false);
      return true;
    }
    let start = data[0] | (data[1] << 8);
    if (sa === 0) start = cpu.x | (cpu.y << 8);
    const body = data.subarray(2);
    const len = Math.min(body.length, 0x10000 - start);
    this.ram.set(body.subarray(0, len), start);
    const end = start + len;
    ram[0xae] = end & 0xff; ram[0xaf] = end >> 8;
    ram[0x90] = 0x40; // EOF
    cpu.x = end & 0xff; cpu.y = end >> 8; cpu.c = 0; cpu.a = 0;
    this.onDiskLoad?.(label, true, start);
    return true;
  }
}

export function asciiToPetscii(ch: string): number {
  const c = ch.charCodeAt(0);
  if (ch === '\n') return 13;
  if (c >= 0x61 && c <= 0x7a) return c - 0x20;      // a-z → unshifted letters
  if (c >= 0x20 && c <= 0x5d) return c;             // space..] (incl. A-Z)
  if (ch === '£') return 0x5c;
  if (ch === '^' || ch === '↑') return 0x5e;
  if (ch === '_' || ch === '←') return 0x5f;
  if (ch === 'π') return 0xff;
  return -1;
}
