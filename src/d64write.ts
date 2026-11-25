// Writing to a D64 image in place: BAM allocation, directory entries, scratch, rename, format.

import { sectorsPerTrack } from './gcr';

export const D64_SIZE = 174848;

const offset = (t: number, s: number) => {
  let o = 0;
  for (let i = 1; i < t; i++) o += sectorsPerTrack(i) * 256;
  return o + s * 256;
};
const BAM = offset(18, 0);
const pad16 = (name: Uint8Array) => { const o = new Uint8Array(16).fill(0xa0); o.set(name.subarray(0, 16)); return o; };
const tracksOf = (img: Uint8Array) => (img.length >= 196608 ? 40 : 35);

// ---- BAM ----
function isFree(img: Uint8Array, t: number, s: number) {
  if (t > 35) return false; // the standard BAM covers 35 tracks
  return (img[BAM + t * 4 + 1 + (s >> 3)] & (1 << (s & 7))) !== 0;
}
function allocate(img: Uint8Array, t: number, s: number) {
  const o = BAM + t * 4;
  if (!isFree(img, t, s)) return;
  img[o + 1 + (s >> 3)] &= ~(1 << (s & 7));
  img[o]--;
}
function release(img: Uint8Array, t: number, s: number) {
  if (t < 1 || t > 35 || s >= sectorsPerTrack(t)) return;
  const o = BAM + t * 4;
  if (isFree(img, t, s)) return;
  img[o + 1 + (s >> 3)] |= 1 << (s & 7);
  img[o]++;
}
export function blocksFree(img: Uint8Array) {
  let n = 0;
  for (let t = 1; t <= 35; t++) if (t !== 18) n += img[BAM + t * 4];
  return n;
}

/** Next free sector like the 1541 DOS: tracks closest to the directory first, interleave 10. */
function nextFree(img: Uint8Array, lastT: number, lastS: number): [number, number] | null {
  const order: number[] = [];
  if (lastT && lastT !== 18) order.push(lastT);
  for (let d = 1; d <= 17; d++) for (const t of [18 - d, 18 + d]) if (t >= 1 && t <= 35 && !order.includes(t)) order.push(t);
  for (const t of order) {
    const n = sectorsPerTrack(t);
    if (img[BAM + t * 4] === 0) continue;
    const start = t === lastT ? (lastS + 10) % n : 0;
    for (let i = 0; i < n; i++) {
      const s = (start + i) % n;
      if (isFree(img, t, s)) return [t, s];
    }
  }
  return null;
}

// ---- directory ----
interface DirSlot { off: number; }
function* dirEntries(img: Uint8Array): Generator<DirSlot> {
  let t = 18, s = 1;
  const seen = new Set<string>();
  while (t === 18 && !seen.has(`${t}/${s}`)) {
    seen.add(`${t}/${s}`);
    const o = offset(t, s);
    for (let e = 0; e < 8; e++) yield { off: o + e * 32 };
    t = img[o]; s = img[o + 1];
  }
}
function nameAt(img: Uint8Array, off: number) {
  let end = off + 5 + 16;
  while (end > off + 5 && img[end - 1] === 0xa0) end--;
  return img.slice(off + 5, end);
}
function matches(pattern: Uint8Array, name: Uint8Array) {
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i];
    if (p === 0x2a) return true;
    if (i >= name.length) return false;
    if (p !== 0x3f && p !== name[i]) return false;
  }
  return pattern.length === name.length;
}
function findEntry(img: Uint8Array, name: Uint8Array): number {
  for (const { off } of dirEntries(img)) if (img[off + 2] && matches(name, nameAt(img, off))) return off;
  return -1;
}
function freeChain(img: Uint8Array, t: number, s: number) {
  const seen = new Set<string>();
  while (t >= 1 && t <= tracksOf(img) && !seen.has(`${t}/${s}`)) {
    seen.add(`${t}/${s}`);
    const o = offset(t, s);
    const nt = img[o], ns = img[o + 1];
    release(img, t, s);
    t = nt; s = ns;
    if (t === 0) break;
  }
}

/** Get a free directory slot, extending the directory on track 18 if needed. */
function freeSlot(img: Uint8Array): number {
  let last = -1;
  for (const { off } of dirEntries(img)) { if (img[off + 2] === 0) return off; last = off; }
  // all directory sectors are full: chain a new one on track 18
  const lastSector = (last - offset(18, 0)) >> 8;
  for (let i = 1; i < sectorsPerTrack(18); i++) {
    const s = (lastSector + 3 * i) % sectorsPerTrack(18);
    if (s === 0 || !isFree(img, 18, s)) continue;
    allocate(img, 18, s);
    const prev = offset(18, lastSector);
    img[prev] = 18; img[prev + 1] = s;
    const o = offset(18, s);
    img.fill(0, o, o + 256);
    img[o + 1] = 0xff;
    return o;
  }
  return -1;
}

export type FileType = 'PRG' | 'SEQ' | 'USR';
const TYPE_CODE: Record<FileType, number> = { SEQ: 0x81, PRG: 0x82, USR: 0x83 };

/** Write a file. Returns a CBM DOS status code: 0 ok, 63 file exists, 72 disk full. */
export function writeFile(img: Uint8Array, name: Uint8Array, type: FileType, data: Uint8Array, replace = false): number {
  const existing = findEntry(img, name);
  if (existing >= 0) {
    if (!replace) return 63;
    freeChain(img, img[existing + 3], img[existing + 4]);
    img.fill(0, existing + 2, existing + 32);
  }
  const blocks = Math.max(1, Math.ceil(data.length / 254));
  if (blocks > blocksFree(img)) return 72;
  const slot = freeSlot(img);
  if (slot < 0) return 72;
  const chain: [number, number][] = [];
  let lt = 0, ls = 0;
  for (let i = 0; i < blocks; i++) {
    const n = nextFree(img, lt, ls);
    if (!n) { for (const [t, s] of chain) release(img, t, s); return 72; }
    allocate(img, n[0], n[1]);
    chain.push(n); [lt, ls] = n;
  }
  chain.forEach(([t, s], i) => {
    const o = offset(t, s);
    const part = data.subarray(i * 254, i * 254 + 254);
    img.fill(0, o, o + 256);
    img.set(part, o + 2);
    if (i < chain.length - 1) { img[o] = chain[i + 1][0]; img[o + 1] = chain[i + 1][1]; }
    else { img[o] = 0; img[o + 1] = part.length + 1; }
  });
  img[slot + 2] = TYPE_CODE[type];
  img[slot + 3] = chain[0][0]; img[slot + 4] = chain[0][1];
  img.set(pad16(name), slot + 5);
  img.fill(0, slot + 21, slot + 30);
  img[slot + 30] = blocks & 0xff; img[slot + 31] = blocks >> 8;
  return 0;
}

/** Delete matching files; returns how many were deleted. */
export function scratch(img: Uint8Array, pattern: Uint8Array): number {
  let n = 0;
  for (const { off } of dirEntries(img)) {
    if (!img[off + 2] || !matches(pattern, nameAt(img, off))) continue;
    freeChain(img, img[off + 3], img[off + 4]);
    img[off + 2] = 0;
    n++;
  }
  return n;
}

/** Rename; returns a DOS status code (0, 62 not found, 63 exists). */
export function rename(img: Uint8Array, newName: Uint8Array, oldName: Uint8Array): number {
  if (findEntry(img, newName) >= 0) return 63;
  const off = findEntry(img, oldName);
  if (off < 0) return 62;
  img.set(pad16(newName), off + 5);
  return 0;
}

/** Format (N:name,id) — a new empty disk in place. */
export function format(img: Uint8Array, name: Uint8Array, id: Uint8Array) {
  img.fill(0);
  const b = BAM;
  img[b] = 18; img[b + 1] = 1; img[b + 2] = 0x41;
  for (let t = 1; t <= 35; t++) {
    const n = sectorsPerTrack(t);
    img[b + t * 4] = n;
    for (let s = 0; s < n; s++) img[b + t * 4 + 1 + (s >> 3)] |= 1 << (s & 7);
  }
  img.fill(0xa0, b + 0x90, b + 0xab);
  img.set(pad16(name), b + 0x90);
  img[b + 0xa2] = id[0] ?? 0x30; img[b + 0xa3] = id[1] ?? 0x30;
  img[b + 0xa5] = 0x32; img[b + 0xa6] = 0x41; // "2A"
  allocate(img, 18, 0); allocate(img, 18, 1);
  const d = offset(18, 1);
  img[d + 1] = 0xff;
}

export function blankD64(name = 'DISCO NUOVO', id = '01'): Uint8Array {
  const img = new Uint8Array(D64_SIZE);
  format(img, Uint8Array.from(name.toUpperCase(), (c) => c.charCodeAt(0)), Uint8Array.from(id.toUpperCase(), (c) => c.charCodeAt(0)));
  return img;
}
