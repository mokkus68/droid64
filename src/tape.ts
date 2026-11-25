// Datasette emulation from .TAP images (pulse lengths). The read signal drives the CIA1 FLAG
// pin; the KERNAL and turbo loaders measure the time between pulses with the CIA timers.

export class Tape {
  readonly name: string;
  private data: Uint8Array;  // pulse data after the 20-byte header
  private version: number;
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
  get running() { return this.playing && this.motor && !this.atEnd; }

  rewind() { this.pos = 0; this.left = 0; }

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
    if (!this.playing || !this.motor) return;
    this.left -= n;
    while (this.left <= 0) {
      if (this.atEnd) { this.playing = false; this.onEnd(); return; }
      this.left += this.nextPulse();
      this.onEdge();
    }
  }
}
