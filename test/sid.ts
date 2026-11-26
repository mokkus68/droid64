// SID models: filter curves, combined waveforms, volume-register digis
import { SID } from '../src/sid';

const SR = 44100;
function render(model: '6581' | '8580', setup: (s: SID) => void, seconds = 0.3, perSample?: (s: SID, i: number) => void): Float32Array {
  const s = new SID(SR);
  s.model = model;
  setup(s);
  s.startRecording(seconds + 1);
  const cps = 985248 / SR;
  const n = Math.floor(seconds * SR);
  for (let i = 0; i < n; i++) { perSample?.(s, i); s.clock(cps); }
  return s.stopRecording()!.subarray(Math.floor(0.05 * SR)); // skip the attack
}
const rms = (a: Float32Array) => Math.sqrt(a.reduce((x, v) => x + v * v, 0) / a.length);
const freqReg = (hz: number) => Math.round(hz * 16777216 / 985248);

// a 3 kHz sawtooth, through the low-pass filter at the lowest and a middle cutoff
const tone = (fcHi: number, filtered: boolean) => (s: SID) => {
  const f = freqReg(3000);
  s.write(0, f & 255); s.write(1, f >> 8);
  s.write(5, 0x00); s.write(6, 0xf0);       // instant attack, full sustain
  s.write(0x15, 0); s.write(0x16, fcHi);
  s.write(0x17, filtered ? 0x01 : 0x00);    // voice 1 through the filter
  s.write(0x18, 0x1f);                      // low-pass, volume 15
  s.write(4, 0x21);                         // sawtooth + gate
};
for (const model of ['6581', '8580'] as const) {
  const dry = rms(render(model, tone(0, false)));
  const low = rms(render(model, tone(0, true)));
  const mid = rms(render(model, tone(0x80, true)));
  console.log(`${model}: sega a 3 kHz, passa-basso col taglio al minimo ${(100 * low / dry).toFixed(1)}% · a metà corsa ${(100 * mid / dry).toFixed(1)}% del segnale diretto`);
}

// combined waveforms: triangle+saw and pulse+saw are not silent, and weaker on the 6581
for (const [name, ctrl] of [['triangolo+sega', 0x31], ['impulso+sega', 0x61], ['impulso+triangolo', 0x51]] as const) {
  const lvl = (model: '6581' | '8580') => rms(render(model, (s) => {
    const f = freqReg(440); s.write(0, f & 255); s.write(1, f >> 8);
    s.write(2, 0x00); s.write(3, 0x08); s.write(5, 0); s.write(6, 0xf0); s.write(0x18, 0x0f); s.write(4, ctrl);
  }));
  const single = rms(render('8580', (s) => {
    const f = freqReg(440); s.write(0, f & 255); s.write(1, f >> 8); s.write(5, 0); s.write(6, 0xf0); s.write(0x18, 0x0f); s.write(4, 0x21);
  }));
  console.log(`${name}: livello 8580 ${(100 * lvl('8580') / single).toFixed(0)}% · 6581 ${(100 * lvl('6581') / single).toFixed(0)}% rispetto alla sola sega`);
}

// "digi": a 4 kHz square wave played only by writing the volume register
for (const model of ['6581', '8580'] as const) {
  const out = render(model, () => {}, 0.3, (s, i) => s.write(0x18, (Math.floor(i / (SR / 8000)) & 1) ? 15 : 0));
  console.log(`${model}: campioni via registro del volume, livello ${rms(out).toFixed(3)}`);
}
