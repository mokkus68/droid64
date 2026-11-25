// Encode a PRG as a standard CBM KERNAL tape (TAP v1), for tests.
const S = 0x30, M = 0x42, L = 0x56; // pulse lengths in TAP units (8 cycles)

export function prgToTap(prg: Uint8Array, name: string, type: 1 | 3 = 1): Uint8Array {
  const p: number[] = [];
  const pulses = (v: number, n: number) => { for (let i = 0; i < n; i++) p.push(v); };
  const byte = (b: number) => {
    p.push(L, M); // new-data marker
    let parity = 1;
    for (let i = 0; i < 8; i++) {
      const bit = (b >> i) & 1;
      parity ^= bit;
      if (bit) p.push(M, S); else p.push(S, M);
    }
    if (parity) p.push(M, S); else p.push(S, M);
  };
  const block = (payload: number[], repeat: boolean) => {
    for (let c = 9; c >= 1; c--) byte(repeat ? c : c | 0x80);
    let sum = 0;
    for (const b of payload) { byte(b); sum ^= b; }
    byte(sum);
    p.push(L, S); // end-of-data marker
  };
  const start = prg[0] | (prg[1] << 8);
  const end = start + prg.length - 2;
  const header = [type, start & 255, start >> 8, end & 255, end >> 8];
  const nm = name.toUpperCase().padEnd(16, ' ').slice(0, 16);
  for (const ch of nm) header.push(ch.charCodeAt(0));
  while (header.length < 192) header.push(0x20);
  const data = Array.from(prg.subarray(2));
  pulses(S, 0x6a00); block(header, false); pulses(S, 0x4f); block(header, true); pulses(S, 0x4e);
  p.push(0, 0x20, 0x4e, 0x00); // ~0.3 s silence (v1 long pulse)
  pulses(S, 0x1a00); block(data, false); pulses(S, 0x4f); block(data, true); pulses(S, 0x4e);
  const out = new Uint8Array(20 + p.length);
  out.set(Array.from('C64-TAPE-RAW', (c) => c.charCodeAt(0)), 0);
  out[12] = 1;
  const n = p.length;
  out[16] = n & 255; out[17] = (n >> 8) & 255; out[18] = (n >> 16) & 255; out[19] = n >>> 24;
  out.set(p, 20);
  return out;
}
