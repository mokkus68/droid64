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

// ---- decoding: works on the raw bit stream, so sync marks need not be byte aligned ----
const DEC = new Int8Array(32).fill(-1);
GCR.forEach((code, nibble) => { DEC[code] = nibble; });

const bitAt = (track: Uint8Array, bits: number, i: number) => {
  i %= bits;
  return (track[i >> 3] >> (7 - (i & 7))) & 1;
};

/** Decode `count` raw bytes from GCR starting at bit `pos` of a circular track; null on invalid codes. */
function decodeBits(track: Uint8Array, bits: number, pos: number, count: number): number[] | null {
  const out: number[] = [];
  for (let n = 0; n < count; n++) {
    let byte = 0;
    for (let half = 0; half < 2; half++) {
      let code = 0;
      for (let k = 0; k < 5; k++) code = (code << 1) | bitAt(track, bits, pos++);
      const v = DEC[code];
      if (v < 0) return null;
      byte = (byte << 4) | v;
    }
    out.push(byte);
  }
  return out;
}

/** Bit positions right after each sync mark (10 or more 1 bits) of a circular track. */
function syncEnds(track: Uint8Array, bits: number): number[] {
  const ends: number[] = [];
  if (!bits) return ends;
  // start counting from a 0 bit so a sync wrapping around the end is seen whole
  let start = 0;
  while (start < bits && bitAt(track, bits, start)) start++;
  let ones = 0;
  for (let k = 1; k <= bits; k++) {
    const i = (start + k) % bits;
    if (bitAt(track, bits, i)) ones++;
    else { if (ones >= 10) ends.push(i); ones = 0; }
  }
  return ends;
}

/**
 * Scan a GCR track for header + data blocks and copy every valid sector back into a D64 image.
 * Returns the number of sectors updated. `bits` defaults to the whole array.
 */
export function gcrTrackToD64(track: Uint8Array, trackNo: number, img: Uint8Array, bits = track.length * 8): number {
  if (!bits) return 0;
  const ends = syncEnds(track, bits);
  let updated = 0;
  for (let k = 0; k < ends.length; k++) {
    const h = decodeBits(track, bits, ends[k], 8);
    if (!h || h[0] !== 0x08) continue;
    const sector = h[2], t = h[3];
    if (t !== trackNo || sector >= sectorsPerTrack(t)) continue;
    const d = decodeBits(track, bits, ends[(k + 1) % ends.length], 260);
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

// ---- G64: raw GCR images (tracks and half tracks) ----
export interface GcrDisk {
  /** indexed by half track (2 = track 1, 3 = track 1.5, …); null = no data */
  tracks: (Uint8Array | null)[];
  /** length of each track in bits */
  bits: number[];
}

export const isG64 = (img: Uint8Array) => String.fromCharCode(...img.subarray(0, 8)) === 'GCR-1541';

export function parseG64(img: Uint8Array): GcrDisk {
  if (!isG64(img)) throw new Error('non è un file G64');
  const dv = new DataView(img.buffer, img.byteOffset, img.byteLength);
  const n = img[9];
  const tracks: (Uint8Array | null)[] = new Array(86).fill(null);
  const bits: number[] = new Array(86).fill(0);
  for (let i = 0; i < n && i < 84; i++) {
    const off = dv.getUint32(0x0c + i * 4, true);
    if (!off || off + 2 > img.length) continue;
    const len = dv.getUint16(off, true);
    if (!len) continue;
    tracks[i + 2] = img.slice(off + 2, off + 2 + len);
    bits[i + 2] = len * 8;
  }
  return { tracks, bits };
}

/** The GCR disk of a D64 image: whole tracks only, half tracks empty. */
export function d64ToGcrDisk(img: Uint8Array): GcrDisk {
  const per = d64ToGcr(img);
  const tracks: (Uint8Array | null)[] = new Array(86).fill(null);
  const bits: number[] = new Array(86).fill(0);
  for (let t = 1; t < per.length && t <= 42; t++) if (per[t].length) { tracks[t * 2] = per[t]; bits[t * 2] = per[t].length * 8; }
  return { tracks, bits };
}

/** Serialize as a G64 (84 half tracks). */
export function toG64(disk: GcrDisk): Uint8Array {
  const n = 84;
  const maxLen = Math.max(7928, ...disk.tracks.map((t) => (t ? t.length : 0)));
  const parts: Uint8Array[] = [];
  const header = new Uint8Array(0x0c + n * 8);
  header.set(Array.from('GCR-1541', (c) => c.charCodeAt(0)), 0);
  header[8] = 0; header[9] = n;
  header[10] = maxLen & 255; header[11] = maxLen >> 8;
  const dv = new DataView(header.buffer);
  let off = header.length;
  for (let i = 0; i < n; i++) {
    const t = disk.tracks[i + 2];
    const track = i + 2 >> 1;
    dv.setUint32(0x0c + n * 4 + i * 4, speedZone(Math.max(1, track)), true);
    if (!t) continue;
    dv.setUint32(0x0c + i * 4, off, true);
    const block = new Uint8Array(2 + maxLen);
    const len = Math.ceil(disk.bits[i + 2] / 8);
    block[0] = len & 255; block[1] = len >> 8;
    block.set(t.subarray(0, len), 2);
    block.fill(0x55, 2 + len);
    parts.push(block);
    off += block.length;
  }
  const out = new Uint8Array(off);
  out.set(header);
  let p = header.length;
  for (const b of parts) { out.set(b, p); p += b.length; }
  return out;
}

/** Decode every whole track of a GCR disk into a D64 image (for directory listings, virtual drive). */
export function gcrDiskToD64(disk: GcrDisk): Uint8Array {
  const img = new Uint8Array(174848);
  for (let t = 1; t <= 35; t++) {
    const tr = disk.tracks[t * 2];
    if (tr) gcrTrackToD64(tr, t, img, disk.bits[t * 2]);
  }
  return img;
}
