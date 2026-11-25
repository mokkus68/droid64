// Datasette emulation from .TAP images (pulse lengths). The read signal drives the CIA1 FLAG
// pin; the KERNAL and turbo loaders measure the time between pulses with the CIA timers.

export class Tape {
  readonly name: string;
  private data: Uint8Array;  // pulse data after the 20-byte header
  private version: number;
  /** RECORD pressed together with PLAY */
  recording = false;
  private rec: number[] = [];        // TAP bytes recorded since recording started
  private recStart = 0;              // tape position where recording started
  private lastEdge = -1;             // C64 time of the last rising edge on the write line
  private lastLevel = 0;
  /** the recording was committed to the tape (it changed) */
  onChanged: () => void = () => {};
  pos = 0;                   // index into data
  private left = 0;          // C64 cycles until the next pulse edge
  playing = false;           // PLAY key pressed
  /** set by the machine from the processor port (bit 5 low = motor on) */
  motor = false;
  onEdge: () => void = () => {};
  onEnd: () => void = () => {};

  constructor(img: Uint8Array, name: string) {
    const sig = String.fromCharCode(...img.subarray(0, 12));
    if (sig !== 'C64-TAPE-RAW') throw new Error('non è un file .TAP del C64');
    this.version = img[12];
    if (this.version > 1) throw new Error(`versione TAP ${this.version} non supportata`);
    const size = img[16] | (img[17] << 8) | (img[18] << 16) | (img[19] << 24);
    this.data = img.subarray(20, Math.min(img.length, 20 + (size >>> 0 || img.length)));
    this.name = name;
  }

  get length() { return this.data.length; }
  get progress() { return this.data.length ? this.pos / this.data.length : 0; }
  get atEnd() { return this.pos >= this.data.length; }
  get running() { return this.playing && this.motor && (this.recording || !this.atEnd); }
  get recordedBytes() { return this.rec.length; }

  rewind() { this.commit(); this.pos = 0; this.left = 0; }

  /** Press RECORD + PLAY: what the C64 writes from the current position on replaces the rest of the tape. */
  startRecording() {
    this.commit();
    this.recording = true;
    this.playing = true;
    this.recStart = Math.min(this.pos, this.data.length);
    this.rec = [];
    this.lastEdge = -1;
  }

  /** STOP: release the keys and keep what was recorded. */
  stop() {
    this.commit();
    this.recording = false;
    this.playing = false;
  }

  /** The C64 changed the cassette write line (processor port bit 3) at time `now` (C64 cycles). */
  writeLine(level: number, now: number) {
    const rising = level && !this.lastLevel;
    this.lastLevel = level;
    if (!this.recording || !this.motor || !rising) return;
    if (this.lastEdge >= 0) {
      const cycles = now - this.lastEdge;
      const v = Math.round(cycles / 8);
      if (v >= 1 && v <= 255) this.rec.push(v);
      else { const c = Math.min(cycles, 0xffffff); this.rec.push(0, c & 255, (c >> 8) & 255, c >> 16); }
    }
    this.lastEdge = now;
  }

  /** The motor stopped (or recording ended): append the recorded pulses to the tape. */
  commit() {
    this.lastEdge = -1;
    if (!this.rec.length) return;
    const head = this.data.subarray(0, this.recStart);
    const out = new Uint8Array(head.length + this.rec.length);
    out.set(head);
    out.set(this.rec, head.length);
    this.data = out;
    this.version = 1;
    this.recStart = out.length;
    this.pos = out.length;
    this.rec = [];
    this.onChanged();
  }

  /** The whole tape as a .TAP file (version 1). */
  toTap(): Uint8Array {
    this.commit();
    const out = new Uint8Array(20 + this.data.length);
    out.set(Array.from('C64-TAPE-RAW', (c) => c.charCodeAt(0)), 0);
    out[12] = 1;
    const n = this.data.length;
    out[16] = n & 255; out[17] = (n >> 8) & 255; out[18] = (n >> 16) & 255; out[19] = (n >>> 24) & 255;
    out.set(this.data, 20);
    return out;
  }

  /** Length in C64 cycles of the next pulse, advancing the position. */
  private nextPulse(): number {
    const d = this.data;
    const v = d[this.pos++];
    if (v !== 0) return v * 8;
    if (this.version === 0) return 256 * 8 * 10; // overflow: a long silence
    const n = d[this.pos] | (d[this.pos + 1] << 8) | (d[this.pos + 2] << 16);
    this.pos += 3;
    return n || 256 * 8;
  }

  /** Advance the tape by n cycles while the motor runs. */
  clock(n: number) {
    if (!this.playing || !this.motor || this.recording) return;
    this.left -= n;
    while (this.left <= 0) {
      if (this.atEnd) { this.playing = false; this.onEnd(); return; }
      this.left += this.nextPulse();
      this.onEdge();
    }
  }
}

/** An empty tape ready for recording. */
export function blankTap(): Uint8Array {
  const out = new Uint8Array(20);
  out.set(Array.from('C64-TAPE-RAW', (c) => c.charCodeAt(0)), 0);
  out[12] = 1;
  return out;
}
