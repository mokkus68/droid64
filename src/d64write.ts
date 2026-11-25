// Writing to a D64 image in place: BAM allocation, directory entries, scratch, rename, format.

import { geometryFor, blankDisk, freeBlocks as geomFree, Geometry } from './geometry';

export const D64_SIZE = 174848;

const pad16 = (name: Uint8Array) => { const o = new Uint8Array(16).fill(0xa0); o.set(name.subarray(0, 16)); return o; };

export function blocksFree(img: Uint8Array) { return geomFree(img); }

/** Next free sector like the CBM DOS: tracks closest to the directory first, with the drive's interleave. */
function nextFree(img: Uint8Array, g: Geometry, lastT: number, lastS: number): [number, number] | null {
  const order: number[] = [];
  if (lastT && !g.reserved.includes(lastT)) order.push(lastT);
  const all: number[] = [];
  for (let t = 1; t <= g.tracks; t++) if (!g.reserved.includes(t)) all.push(t);
  // side 1 first (by distance from the directory track), then side 2 of a D71
  const side = (t: number) => (g.kind === 'd71' && t > 35 ? 1 : 0);
  all.sort((x, y) => side(x) - side(y) || Math.abs(x - g.dirTrack - side(x) * 35) - Math.abs(y - g.dirTrack - side(y) * 35) || x - y);
  for (const t of all) if (!order.includes(t)) order.push(t);
  for (const t of order) {
    const n = g.spt(t);
    if (g.freeOnTrack(img, t) === 0) continue;
    const start = t === lastT ? (lastS + g.interleave) % n : 0;
    for (let i = 0; i < n; i++) {
      const s = (start + i) % n;
      if (g.isFree(img, t, s)) return [t, s];
    }
  }
  return null;
}

// ---- directory ----
interface DirSlot { off: number; }
function* dirEntries(img: Uint8Array): Generator<DirSlot> {
  const g = geometryFor(img);
  let t = g.dirTrack, s = g.firstDirSector;
  const seen = new Set<string>();
  while (t === g.dirTrack && s < g.spt(t) && !seen.has(`${t}/${s}`)) {
    seen.add(`${t}/${s}`);
    const o = g.offset(t, s);
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
  const g = geometryFor(img);
  const seen = new Set<string>();
  while (t >= 1 && t <= g.tracks && s < g.spt(t) && !seen.has(`${t}/${s}`)) {
    seen.add(`${t}/${s}`);
    const o = g.offset(t, s);
    const nt = img[o], ns = img[o + 1];
    g.release(img, t, s);
    t = nt; s = ns;
    if (t === 0) break;
  }
}

/** Get a free directory slot, extending the directory on the directory track if needed. */
function freeSlot(img: Uint8Array): number {
  const g = geometryFor(img);
  let last = -1;
  for (const { off } of dirEntries(img)) { if (img[off + 2] === 0) return off; last = off; }
  const lastSector = ((last - g.offset(g.dirTrack, 0)) >> 8);
  const n = g.spt(g.dirTrack);
  for (let i = 1; i < n; i++) {
    const s = (lastSector + (g.kind === 'd81' ? 1 : 3) * i) % n;
    if (!g.isFree(img, g.dirTrack, s)) continue;
    g.allocate(img, g.dirTrack, s);
    const prev = g.offset(g.dirTrack, lastSector);
    img[prev] = g.dirTrack; img[prev + 1] = s;
    const o = g.offset(g.dirTrack, s);
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
  const g = geometryFor(img);
  const blocks = Math.max(1, Math.ceil(data.length / 254));
  if (blocks > blocksFree(img)) return 72;
  const slot = freeSlot(img);
  if (slot < 0) return 72;
  const chain: [number, number][] = [];
  let lt = 0, ls = 0;
  for (let i = 0; i < blocks; i++) {
    const n = nextFree(img, g, lt, ls);
    if (!n) { for (const [t, s] of chain) g.release(img, t, s); return 72; }
    g.allocate(img, n[0], n[1]);
    chain.push(n); [lt, ls] = n;
  }
  chain.forEach(([t, s], i) => {
    const o = g.offset(t, s);
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
  geometryFor(img).format(img, name, id);
}

export function blankD64(name = 'DISCO NUOVO', id = '01'): Uint8Array {
  return blankDisk('d64', name, id);
}
