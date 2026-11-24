import { C64 } from '../src/c64';
import { OPEN_BASIC, OPEN_KERNAL, OPEN_CHARGEN } from '../src/roms';
import { readFileSync, writeFileSync } from 'fs';
const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
export function makeC64() {
  return new C64({ basic: b64(OPEN_BASIC), kernal: b64(OPEN_KERNAL), chargen: b64(OPEN_CHARGEN) });
}
export function screenText(c: C64) {
  let s = '';
  const base = (c.vic.regs[0x18] >> 4) * 0x400;
  for (let r = 0; r < 25; r++) {
    let line = '';
    for (let x = 0; x < 40; x++) {
      const v = c.ram[base + r * 40 + x] & 0x7f;
      line += v < 32 ? String.fromCharCode(v + 64) : v < 64 ? String.fromCharCode(v) : '#';
    }
    s += line.trimEnd() + '\n';
  }
  return s;
}
export function savePpm(c: C64, path: string) {
  const fb = c.vic.frameBuffer, w = 384, h = 272;
  const out = Buffer.alloc(w * h * 3 + 20);
  const hdr = `P6 ${w} ${h} 255\n`; out.write(hdr);
  let o = hdr.length;
  for (let i = 0; i < w * h; i++) { const p = fb[i]; out[o++] = p & 255; out[o++] = (p >> 8) & 255; out[o++] = (p >> 16) & 255; }
  writeFileSync(path, out.subarray(0, o));
}
export function makeOrigC64() {
  const d = process.env.ORIG!;
  const r = (f: string) => new Uint8Array(readFileSync(d + '/' + f));
  return new C64({ basic: r('basic-901226-01.bin'), kernal: r('kernal-901227-03.bin'), chargen: r('chargen-901225-01.bin') });
}
