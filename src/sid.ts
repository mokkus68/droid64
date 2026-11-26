// MOS 6581 SID — approximate sample-based emulation

const CLOCK = 985248;
// envelope rate periods in cycles per step (from the datasheet / reSID)
const RATE_PERIOD = [9, 32, 63, 95, 149, 220, 267, 313, 392, 977, 1954, 3126, 3907, 11720, 19532, 31251];

const enum Env { ATTACK, DECAY, RELEASE }

class Voice {
  freq = 0; pw = 0; ctrl = 0; ad = 0; sr = 0;
  acc = 0;               // 24-bit phase accumulator (float for fractional steps)
  noise = 0x7ffff8;      // 23-bit LFSR
  env = 0; envState = Env.RELEASE; envFrac = 0;
  msbRising = false;     // set when accumulator MSB went 0->1 this sample (for sync)
  output = 0;            // last 12-bit wave output

  writeCtrl(v: number) {
    const gateOn = (v & 1) && !(this.ctrl & 1);
    const gateOff = !(v & 1) && (this.ctrl & 1);
    if (gateOn) this.envState = Env.ATTACK;
    if (gateOff) this.envState = Env.RELEASE;
    if (v & 8) { this.acc = 0; this.noise = 0x7ffff8; }
    this.ctrl = v;
  }

  stepEnvelope(cycles: number) {
    let period: number;
    switch (this.envState) {
      case Env.ATTACK:
        period = RATE_PERIOD[this.ad >> 4];
        this.env += cycles / period;
        if (this.env >= 255) { this.env = 255; this.envState = Env.DECAY; }
        break;
      case Env.DECAY: {
        const sustain = (this.sr >> 4) * 17;
        if (this.env > sustain) {
          period = RATE_PERIOD[this.ad & 15] * expDiv(this.env);
          this.env -= cycles / period;
          if (this.env < sustain) this.env = sustain;
        }
        break;
      }
      case Env.RELEASE:
        if (this.env > 0) {
          period = RATE_PERIOD[this.sr & 15] * expDiv(this.env);
          this.env -= cycles / period;
          if (this.env < 0) this.env = 0;
        }
        break;
    }
  }

  /** advance oscillator by `cycles`; returns true if MSB rose */
  stepOsc(cycles: number) {
    if (this.ctrl & 8) { this.msbRising = false; return; }
    const old = this.acc;
    let n = old + this.freq * cycles;
    // noise LFSR clocked on rising edges of bit 19
    const edges = Math.floor((n + 0x80000) / 0x100000) - Math.floor((old + 0x80000) / 0x100000);
    for (let i = 0; i < edges && i < 64; i++) {
      const bit = ((this.noise >> 22) ^ (this.noise >> 17)) & 1;
      this.noise = ((this.noise << 1) | bit) & 0x7fffff;
    }
    this.msbRising = Math.floor(n / 0x1000000 + 0.5) > Math.floor(old / 0x1000000 + 0.5);
    n %= 0x1000000;
    this.acc = n;
  }

  wave(ringSrcMsb: number): number {
    const ctrl = this.ctrl;
    const acc = this.acc | 0;
    const wf = ctrl >> 4;
    if (!wf) return 0;
    let out = 0xfff;
    if (wf & 1) { // triangle
      let msb = acc & 0x800000;
      if (ctrl & 4) msb ^= ringSrcMsb;
      out &= ((msb ? ~acc : acc) >> 11) & 0xfff;
    }
    if (wf & 2) out &= acc >> 12;
    if (wf & 4) out &= ((acc >> 12) >= this.pw || (ctrl & 8)) ? 0xfff : 0;
    if (wf & 8) {
      const n = this.noise;
      out &= ((n >> 9) & 0x800) | ((n >> 8) & 0x400) | ((n >> 5) & 0x200) | ((n >> 3) & 0x100) |
        ((n >> 2) & 0x80) | ((n << 1) & 0x40) | ((n << 3) & 0x20) | ((n << 4) & 0x10);
    }
    return out;
  }
}

function expDiv(env: number): number {
  if (env > 93) return 1;
  if (env > 54) return 2;
  if (env > 26) return 4;
  if (env > 14) return 8;
  if (env > 6) return 16;
  return 30;
}

export class SID {
  regs = new Uint8Array(32);
  voices = [new Voice(), new Voice(), new Voice()];
  sampleRate: number;
  private cyclesPerSample: number;
  private cycleDebt = 0;
  // filter state
  private lp = 0; private bp = 0;
  private dcPrevIn = 0; private dcPrevOut = 0;
  // output ring buffer
  buffer: Float32Array;
  writePos = 0; readPos = 0;
  enabled = true;

  constructor(sampleRate = 44100) {
    this.sampleRate = sampleRate;
    this.cyclesPerSample = CLOCK / sampleRate;
    this.buffer = new Float32Array(16384);
  }

  setSampleRate(sr: number) {
    this.sampleRate = sr;
    this.cyclesPerSample = CLOCK / sr;
  }

  reset() {
    this.regs.fill(0);
    for (const v of this.voices) { v.freq = v.pw = v.ctrl = v.ad = v.sr = 0; v.acc = 0; v.env = 0; v.envState = Env.RELEASE; }
    this.lp = this.bp = 0;
  }

  read(reg: number): number {
    reg &= 0x1f;
    switch (reg) {
      case 0x19: case 0x1a: return 0xff;
      case 0x1b: return (this.voices[2].wave(this.voices[1].acc & 0x800000) >> 4) & 0xff;
      case 0x1c: return Math.floor(this.voices[2].env) & 0xff;
    }
    return 0; // write-only registers read as 0 (bus value approximation)
  }

  write(reg: number, v: number) {
    reg &= 0x1f;
    this.regs[reg] = v;
    if (reg < 21) {
      const vi = Math.floor(reg / 7), voice = this.voices[vi];
      switch (reg % 7) {
        case 0: voice.freq = (voice.freq & 0xff00) | v; break;
        case 1: voice.freq = (voice.freq & 0xff) | (v << 8); break;
        case 2: voice.pw = (voice.pw & 0xf00) | v; break;
        case 3: voice.pw = (voice.pw & 0xff) | ((v & 15) << 8); break;
        case 4: voice.writeCtrl(v); break;
        case 5: voice.ad = v; break;
        case 6: voice.sr = v; break;
      }
    }
  }

  /** Advance the SID by `cycles` CPU cycles, producing audio samples. */
  clock(cycles: number) {
    this.cycleDebt += cycles;
    const cps = this.cyclesPerSample;
    while (this.cycleDebt >= cps) {
      this.cycleDebt -= cps;
      this.generateSample(cps);
    }
  }

  private generateSample(cps: number) {
    const [v1, v2, v3] = this.voices;
    v1.stepOsc(cps); v2.stepOsc(cps); v3.stepOsc(cps);
    // hard sync: voice n synced by voice n-1 (v1 by v3)
    if ((v1.ctrl & 2) && v3.msbRising) v1.acc = 0;
    if ((v2.ctrl & 2) && v1.msbRising) v2.acc = 0;
    if ((v3.ctrl & 2) && v2.msbRising) v3.acc = 0;
    v1.stepEnvelope(cps); v2.stepEnvelope(cps); v3.stepEnvelope(cps);

    const o1 = (v1.wave(v3.acc & 0x800000) - 0x800) * v1.env / 255;
    const o2 = (v2.wave(v1.acc & 0x800000) - 0x800) * v2.env / 255;
    const o3 = (v3.wave(v2.acc & 0x800000) - 0x800) * v3.env / 255;

    const regs = this.regs;
    const route = regs[0x17];
    const modeVol = regs[0x18];
    let filtIn = 0, direct = 0;
    if (route & 1) filtIn += o1; else direct += o1;
    if (route & 2) filtIn += o2; else direct += o2;
    if (route & 4) filtIn += o3; else if (!(modeVol & 0x80)) direct += o3;

    // Chamberlin state variable filter
    const fc = (regs[0x15] & 7) | (regs[0x16] << 3);
    const cutoff = Math.min(30 + fc * 5.8, 12000);
    const f = Math.min(2 * Math.sin(Math.PI * cutoff / this.sampleRate), 1.2);
    const res = route >> 4;
    const q = 1.4 - res * 0.075;
    const hp = filtIn - this.lp - q * this.bp;
    this.bp += f * hp;
    this.lp += f * this.bp;
    let filtered = 0;
    if (modeVol & 0x10) filtered += this.lp;
    if (modeVol & 0x20) filtered += this.bp;
    if (modeVol & 0x40) filtered += hp;
    // keep the filter numerically stable
    if (!isFinite(this.lp) || Math.abs(this.lp) > 1e6) { this.lp = 0; this.bp = 0; }

    const vol = (modeVol & 15) / 15;
    // small DC offset scaled by volume lets "volume register" digis be audible like on a 6581
    const raw = ((direct + filtered) / 2048 / 3 + 0.25) * vol;
    // DC blocker
    const sample = raw - this.dcPrevIn + 0.997 * this.dcPrevOut;
    this.dcPrevIn = raw; this.dcPrevOut = sample;

    const buf = this.buffer;
    const next = (this.writePos + 1) & (buf.length - 1);
    if (next === this.readPos) this.readPos = (this.readPos + 1) & (buf.length - 1); // overwrite oldest
    if (this.rec) {
      if (this.recLen >= this.rec.length) this.growRec();
      if (this.rec) this.rec[this.recLen++] = sample;
    }
    buf[this.writePos] = sample;
    this.writePos = next;
  }

  // ---- recording: every generated sample, in emulated time (turbo and mute included) ----
  private rec: Float32Array | null = null;
  private recLen = 0;
  private recMax = 0;
  get recording() { return this.rec !== null; }
  get recordedSeconds() { return this.recLen / this.sampleRate; }
  startRecording(maxSeconds: number) {
    this.recMax = Math.ceil(maxSeconds * this.sampleRate);
    this.rec = new Float32Array(this.sampleRate * 10);
    this.recLen = 0;
  }
  private growRec() {
    if (!this.rec) return;
    if (this.rec.length >= this.recMax) { this.done = this.rec.subarray(0, this.recLen); this.rec = null; return; }
    const n = new Float32Array(Math.min(this.recMax, this.rec.length * 2));
    n.set(this.rec);
    this.rec = n;
  }
  private done: Float32Array | null = null;
  /** Stop and return the recorded samples (also after the time limit stopped it). */
  stopRecording(): Float32Array | null {
    const out = this.rec ? this.rec.slice(0, this.recLen) : this.done;
    this.rec = null; this.done = null; this.recLen = 0;
    return out;
  }

  available(): number {
    return (this.writePos - this.readPos) & (this.buffer.length - 1);
  }

  /** Fill an output array with buffered samples. */
  pull(out: Float32Array) {
    const buf = this.buffer, mask = buf.length - 1;
    let last = 0;
    for (let i = 0; i < out.length; i++) {
      if (this.readPos !== this.writePos) { last = buf[this.readPos]; this.readPos = (this.readPos + 1) & mask; }
      out[i] = last;
    }
  }
}
