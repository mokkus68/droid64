// Virtual 1541 on device 8, answering the KERNAL serial-bus routines
// (LISTEN, TALK, SECOND, TKSA, CIOUT, ACPTR, UNLSN, UNTLK).
// This covers everything that reads the disk through the KERNAL: LOAD, OPEN/GET#/INPUT#,
// the command channel 15 and block reads. Fastloaders that upload their own code to the
// drive and bit-bang the bus cannot work without a real 1541 emulation.

import { D64File, DiskImage, matchName, buildDirectoryListing, parseD64 } from './media';
import { writeFile, scratch, rename, format, FileType } from './d64write';
import { geometryFor } from './geometry';

type Disk = DiskImage & { files: D64File[] };

interface Channel {
  data: Uint8Array | null;   // bytes to send to the C64
  pos: number;
  write: number[] | null;    // bytes received from the C64 (files opened for writing)
  name?: Uint8Array; type?: FileType; replace?: boolean;
}

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

export class VirtualDrive {
  private channels: (Channel | null)[] = new Array(16).fill(null);
  private listening = false;
  private talking = false;
  private listenChannel = -1;
  private listenMode = 0;      // 0xf0 open, 0x60 data
  private nameBuf: number[] = [];
  private talkChannel = -1;
  private status = '73,CBM DOS V2.6 1541,00,00';
  private statusBytes: number[] | null = null;
  private image: Uint8Array | null = null;
  private driveRam = new Uint8Array(2048);
  private buffer = new Uint8Array(256); // direct-access buffer ("#")
  /** set when a program tried to run its own code in the drive (a fastloader) */
  onFastloader: () => void = () => {};
  onActivity: (what: string) => void = () => {};
  /** the disk image was modified (file saved, scratched, renamed, formatted) */
  onDiskChanged: () => void = () => {};

  constructor(public disk: Disk, image: Uint8Array | null) {
    this.image = image;
  }

  reset() {
    this.channels.fill(null);
    this.listening = this.talking = false;
    this.status = '73,CBM DOS V2.6 1541,00,00';
    this.statusBytes = null;
  }

  // ---- bus primitives; each returns the ST bits to OR into $90 ----
  listen(dev: number): boolean {
    if ((dev & 0x1f) !== 8) { this.listening = false; return false; }
    this.listening = true; this.talking = false;
    this.listenChannel = -1;
    return true;
  }
  talk(dev: number): boolean {
    if ((dev & 0x1f) !== 8) { this.talking = false; return false; }
    this.talking = true; this.listening = false;
    this.talkChannel = -1;
    return true;
  }
  get active() { return this.listening || this.talking; }

  second(sa: number) {
    const ch = sa & 0x0f;
    switch (sa & 0xf0) {
      case 0xf0: this.listenChannel = ch; this.listenMode = 0xf0; this.nameBuf = []; break;
      case 0xe0: this.close(ch); this.listenChannel = -1; break;
      default: this.listenChannel = ch; this.listenMode = 0x60; this.nameBuf = []; break;
    }
  }
  tksa(sa: number) {
    this.talkChannel = sa & 0x0f;
    if (this.talkChannel === 15 && !this.statusBytes) this.statusBytes = ascii(this.status + '\r');
  }
  ciout(b: number) {
    if (this.listenChannel < 0) return;
    if (this.listenMode === 0xf0 || this.listenChannel === 15) { this.nameBuf.push(b); return; }
    const c = this.channels[this.listenChannel];
    if (c?.write) c.write.push(b);
    else if (this.listenChannel >= 2 && this.listenChannel < 15 && c && c.data === this.buffer) this.buffer[c.pos++ & 0xff] = b;
  }
  unlisten() {
    if (this.listenChannel >= 0) {
      if (this.listenMode === 0xf0) this.open(this.listenChannel, this.nameBuf);
      else if (this.listenChannel === 15 && this.nameBuf.length) this.command(this.nameBuf);
    }
    this.nameBuf = [];
    this.listenChannel = -1;
    this.listening = false;
  }
  untalk() { this.talking = false; this.talkChannel = -1; }

  /** Returns [byte, stBits]. */
  acptr(): [number, number] {
    const ch = this.talkChannel;
    if (ch === 15) {
      const s = this.statusBytes ?? ascii(this.status + '\r');
      const b = s.shift() ?? 0x0d;
      if (!s.length) { this.statusBytes = null; this.status = '00, OK,00,00'; return [b, 0x40]; }
      this.statusBytes = s;
      return [b, 0];
    }
    const c = ch >= 0 ? this.channels[ch] : null;
    if (!c || !c.data || c.pos >= c.data.length) return [0x0d, 0x42]; // nothing to read: EOI + timeout
    const b = c.data[c.pos++];
    this.onActivity('read');
    return [b, c.pos >= c.data.length ? 0x40 : 0];
  }

  // ---- DOS ----
  private setStatus(code: number, msg: string, t = 0, s = 0) {
    const p = (n: number) => String(n).padStart(2, '0');
    this.status = `${p(code)},${msg},${p(t)},${p(s)}`;
    this.statusBytes = null;
  }

  private open(ch: number, nameBytes: number[]) {
    if (ch === 15) { if (nameBytes.length) this.command(nameBytes); return; }
    let name = Uint8Array.from(nameBytes);
    this.onActivity('open');
    if (name[0] === 0x24) { // "$" directory
      this.channels[ch] = { data: buildDirectoryListing(this.disk), pos: 0, write: null };
      this.setStatus(0, ' OK');
      return;
    }
    if (name[0] === 0x23) { // "#" direct-access buffer
      this.channels[ch] = { data: this.buffer, pos: 0, write: null };
      this.setStatus(0, ' OK');
      return;
    }
    // strip "@", "0:" prefixes and ",type,mode" suffixes
    if (name[0] === 0x40) name = name.subarray(1);
    const colon = name.indexOf(0x3a);
    if (colon >= 0 && colon <= 1) name = name.subarray(colon + 1);
    const parts: Uint8Array[] = [];
    let start = 0;
    for (let i = 0; i <= name.length; i++) if (i === name.length || name[i] === 0x2c) { parts.push(name.subarray(start, i)); start = i + 1; }
    const fname = parts[0];
    const modes = parts.slice(1).map((p) => String.fromCharCode(p[0] ?? 0));
    const writing = ch === 1 || modes.includes('W') || modes.includes('A');
    if (writing) {
      if (!this.image) { this.channels[ch] = null; this.setStatus(26, ' WRITE PROTECT ON'); return; }
      const type: FileType = modes.includes('S') ? 'SEQ' : modes.includes('U') ? 'USR' : modes.includes('P') || ch === 1 ? 'PRG' : 'SEQ';
      this.channels[ch] = { data: null, pos: 0, write: [], name: fname.slice(), type, replace: nameBytes[0] === 0x40 };
      this.setStatus(0, ' OK');
      return;
    }
    const file = this.disk.files.find((f) => f.data && (fname.length === 0 || matchName(fname, f.rawName)));
    if (!file || !file.data) {
      this.channels[ch] = { data: null, pos: 0, write: null };
      this.setStatus(62, ' FILE NOT FOUND');
      return;
    }
    this.channels[ch] = { data: file.data, pos: 0, write: null };
    this.setStatus(0, ' OK');
  }

  /** Save a whole file (used by the KERNAL SAVE hook as well). Returns the DOS status code. */
  saveFile(name: Uint8Array, data: Uint8Array, type: FileType = 'PRG'): number {
    if (!this.image) { this.setStatus(26, ' WRITE PROTECT ON'); return 26; }
    let replace = false;
    if (name[0] === 0x40) { replace = true; name = name.subarray(1); }
    const colon = name.indexOf(0x3a);
    if (colon >= 0 && colon <= 1) name = name.subarray(colon + 1);
    const comma = name.indexOf(0x2c);
    if (comma >= 0) name = name.subarray(0, comma);
    const code = writeFile(this.image, name, type, data, replace);
    this.afterWrite(code);
    return code;
  }

  private afterWrite(code: number) {
    if (code === 0) this.setStatus(0, ' OK');
    else if (code === 63) this.setStatus(63, ' FILE EXISTS');
    else if (code === 62) this.setStatus(62, ' FILE NOT FOUND');
    else this.setStatus(72, ' DISK FULL');
    if (this.image && code === 0) {
      this.disk = parseD64(this.image);
      this.onDiskChanged();
    }
  }

  private close(ch: number) {
    const c = this.channels[ch];
    if (c?.write && c.name && this.image) {
      const code = writeFile(this.image, c.name, c.type ?? 'SEQ', Uint8Array.from(c.write), !!c.replace);
      this.afterWrite(code);
    }
    this.channels[ch] = null;
    if (ch === 15) this.channels.fill(null);
  }

  private readSector(t: number, s: number): Uint8Array | null {
    if (!this.image) return null;
    const g = geometryFor(this.image);
    if (t < 1 || t > g.tracks || s >= g.spt(t)) return null;
    const off = g.offset(t, s);
    if (off + 256 > this.image.length) return null;
    return this.image.subarray(off, off + 256);
  }

  private command(bytes: number[]) {
    while (bytes.length && (bytes[bytes.length - 1] === 0x0d)) bytes = bytes.slice(0, -1);
    const str = String.fromCharCode(...bytes);
    this.onActivity('command');
    if (/^M-W/.test(str)) {
      const addr = bytes[3] | (bytes[4] << 8), n = bytes[5];
      for (let i = 0; i < n; i++) this.driveRam[(addr + i) & 0x7ff] = bytes[6 + i] ?? 0;
      this.setStatus(0, ' OK');
      return;
    }
    if (/^M-E/.test(str) || /^U[3-8C-H]/.test(str) || /^B-E/.test(str)) {
      // the program wants to run its own code inside the drive: a fastloader
      this.onFastloader();
      this.setStatus(0, ' OK');
      return;
    }
    if (/^M-R/.test(str)) {
      const addr = bytes[3] | (bytes[4] << 8), n = bytes[5] || 1;
      const out: number[] = [];
      const rom = ascii('CBM DOS V2.6 1541');
      for (let i = 0; i < n; i++) {
        const a = (addr + i) & 0xffff;
        if (a < 0x800) out.push(this.driveRam[a]);
        else if (a >= 0xe5c5 && a < 0xe5c5 + rom.length) out.push(rom[a - 0xe5c5]);
        else out.push(0);
      }
      this.statusBytes = out; // M-R answers on the command channel
      return;
    }
    if (/^(U1|UA|B-R)/.test(str)) {
      const nums = str.replace(/^(U1|UA|B-R):?/, '').split(/[ ,:]+/).filter(Boolean).map((n) => parseInt(n, 10));
      const [ch, , t, s] = nums;
      const sec = this.readSector(t, s);
      if (!sec) { this.setStatus(66, ' ILLEGAL TRACK OR SECTOR', t || 0, s || 0); return; }
      this.buffer.set(sec);
      const c = this.channels[ch];
      if (c) c.pos = 0;
      this.setStatus(0, ' OK');
      return;
    }
    if (/^B-P/.test(str)) {
      const nums = str.slice(3).split(/[ ,:]+/).filter(Boolean).map((n) => parseInt(n, 10));
      const c = this.channels[nums[0]];
      if (c) c.pos = nums[1] ?? 0;
      this.setStatus(0, ' OK');
      return;
    }
    if (/^UJ|^UI|^U:|^U9|^U;/.test(str)) { this.setStatus(73, 'CBM DOS V2.6 1541'); return; }
    const arg = (from: number) => { const b = Uint8Array.from(bytes.slice(from)); const c = b.indexOf(0x3a); return c >= 0 ? b.subarray(c + 1) : b; };
    if (/^S/.test(str)) { // S0:NAME[,NAME2...]
      if (!this.image) { this.setStatus(26, ' WRITE PROTECT ON'); return; }
      let n = 0;
      for (const part of splitComma(arg(1))) n += scratch(this.image, part);
      this.setStatus(1, ' FILES SCRATCHED', n, 0);
      this.statusBytes = null;
      if (n) { this.disk = parseD64(this.image); this.onDiskChanged(); }
      return;
    }
    if (/^R/.test(str)) { // R0:NEW=OLD
      if (!this.image) { this.setStatus(26, ' WRITE PROTECT ON'); return; }
      const a = arg(1); const eq = a.indexOf(0x3d);
      if (eq < 0) { this.setStatus(30, ' SYNTAX ERROR'); return; }
      let old = a.subarray(eq + 1); const c = old.indexOf(0x3a); if (c >= 0 && c <= 1) old = old.subarray(c + 1);
      this.afterWrite(rename(this.image, a.subarray(0, eq), old));
      return;
    }
    if (/^N/.test(str)) { // N0:NAME,ID
      if (!this.image) { this.setStatus(26, ' WRITE PROTECT ON'); return; }
      const parts = splitComma(arg(1));
      format(this.image, parts[0] ?? new Uint8Array(0), parts[1] ?? Uint8Array.from([0x30, 0x30]));
      this.afterWrite(0);
      return;
    }
    if (/^I|^V|^C|^P|^B-[AFW]|^U2|^UB/.test(str) || str === '') { this.setStatus(0, ' OK'); return; }
    this.setStatus(31, ' SYNTAX ERROR');
  }
}

function splitComma(b: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i <= b.length; i++) if (i === b.length || b[i] === 0x2c) { if (i > start) out.push(b.subarray(start, i)); start = i + 1; }
  return out;
}
