// Convert a D64 image into the GCR byte stream the 1541 read head sees on each track.

const GCR = [0x0a, 0x0b, 0x12, 0x13, 0x0e, 0x0f, 0x16, 0x17, 0x09, 0x19, 0x1a, 0x1b, 0x0d, 0x1d, 0x1e, 0x15];

export const sectorsPerTrack = (t: number) => (t <= 17 ? 21 : t <= 24 ? 19 : t <= 30 ? 18 : 17);
/** speed zone (density) the 1541 DOS selects for a track: 3 = fastest (outer tracks) */
export const speedZone = (t: number) => (t <= 17 ? 3 : t <= 24 ? 2 : t <= 30 ? 1 : 0);
/** GCR bytes per track at each speed zone */
const TRACK_BYTES = [6250, 6666, 7142, 7692];

/** Encode 4 bytes into 5 GCR bytes. */
function encode4(src: number[], out: number[]) {
  let bits = 0n;
  for (const b of src) bits = (bits << 10n) | BigInt((GCR[b >> 4] << 5) | GCR[b & 15]);
  for (let i = 4; i >= 0; i--) out.push(Number((bits >> BigInt(i * 8)) & 0xffn));
}

function encodeBlock(raw: number[], out: number[]) {
  for (let i = 0; i < raw.length; i += 4) encode4(raw.slice(i, i + 4), out);
}

/**
 * Returns GCR data indexed by track number (1-based); index 0 unused.
 * Tracks beyond the image are left empty (unformatted: no sync marks).
 */
export function d64ToGcr(img: Uint8Array): Uint8Array[] {
  const tracks = img.length >= 196608 ? 40 : 35;
  const bam = trackOffset(18);
  const id1 = img[bam + 0xa2], id2 = img[bam + 0xa3];
  const out: Uint8Array[] = [new Uint8Array(0)];
  for (let t = 1; t <= 42; t++) {
    if (t > tracks) { out.push(new Uint8Array(0)); continue; }
    const n = sectorsPerTrack(t);
    const len = TRACK_BYTES[speedZone(t)];
    const bytes: number[] = [];
    const perSector = 5 + 10 + 9 + 5 + 325;
    const gap = Math.max(4, Math.floor((len - n * perSector) / n));
    for (let s = 0; s < n; s++) {
      const off = trackOffset(t) + s * 256;
      for (let i = 0; i < 5; i++) bytes.push(0xff);
      encodeBlock([0x08, s ^ t ^ id2 ^ id1, s, t, id2, id1, 0x0f, 0x0f], bytes);
      for (let i = 0; i < 9; i++) bytes.push(0x55);
      for (let i = 0; i < 5; i++) bytes.push(0xff);
      const data = Array.from(img.subarray(off, off + 256));
      while (data.length < 256) data.push(0);
      let sum = 0;
      for (const b of data) sum ^= b;
      encodeBlock([0x07, ...data, sum, 0, 0], bytes);
      for (let i = 0; i < gap; i++) bytes.push(0x55);
    }
    while (bytes.length < len) bytes.push(0x55);
    out.push(Uint8Array.from(bytes.slice(0, Math.max(len, bytes.length))));
  }
  return out;
}

function trackOffset(track: number): number {
  let off = 0;
  for (let t = 1; t < track; t++) off += sectorsPerTrack(t) * 256;
  return off;
}

// ---- decoding (for writes made by the emulated drive) ----
const DEC = new Int8Array(32).fill(-1);
GCR.forEach((code, nibble) => { DEC[code] = nibble; });

/** Decode `count` raw bytes from GCR starting at byte index `pos` of a circular track; null on invalid codes. */
function decodeAt(track: Uint8Array, pos: number, count: number): number[] | null {
  const out: number[] = [];
  const len = track.length;
  let bitBuf = 0, bits = 0, p = pos;
  const nibbles: number[] = [];
  while (nibbles.length < count * 2) {
    while (bits < 5) { bitBuf = ((bitBuf << 8) | track[p % len]) & 0xffff; p++; bits += 8; }
    const code = (bitBuf >> (bits - 5)) & 31;
    bits -= 5;
    const n = DEC[code];
    if (n < 0) return null;
    nibbles.push(n);
  }
  for (let i = 0; i < nibbles.length; i += 2) out.push((nibbles[i] << 4) | nibbles[i + 1]);
  return out;
}

/**
 * Scan a GCR track for header + data blocks and copy every valid sector back into the D64 image.
 * Returns the number of sectors updated.
 */
export function gcrTrackToD64(track: Uint8Array, trackNo: number, img: Uint8Array): number {
  const len = track.length;
  if (!len) return 0;
  // positions right after each sync mark
  const starts: number[] = [];
  for (let i = 0; i < len; i++) {
    const prev = track[(i - 1 + len) % len], cur = track[i];
    if (prev === 0xff && cur === 0xff) continue;
    if (prev === 0xff && track[(i - 2 + len) % len] === 0xff) starts.push(i);
  }
  let updated = 0;
  for (let k = 0; k < starts.length; k++) {
    const h = decodeAt(track, starts[k], 8);
    if (!h || h[0] !== 0x08) continue;
    const sector = h[2], t = h[3];
    if (t !== trackNo || sector >= sectorsPerTrack(t)) continue;
    const next = starts[(k + 1) % starts.length];
    const d = decodeAt(track, next, 260);
    if (!d || d[0] !== 0x07) continue;
    let sum = 0;
    for (let i = 1; i <= 256; i++) sum ^= d[i];
    if (sum !== d[257]) continue;
    const off = trackOffset(t) + sector * 256;
    if (off + 256 > img.length) continue;
    img.set(d.slice(1, 257), off);
    updated++;
  }
  return updated;
}
