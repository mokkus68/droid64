// Disk image geometries: D64 (1541), D71 (1571, double sided) and D81 (1581, 3.5").

export type DiskKind = 'd64' | 'd71' | 'd81';

export interface Geometry {
  kind: DiskKind;
  tracks: number;
  spt(t: number): number;
  offset(t: number, s: number): number;
  dirTrack: number;
  firstDirSector: number;
  /** where the disk name / id are stored */
  header: { t: number; s: number; name: number; id: number };
  /** tracks that never hold file data */
  reserved: number[];
  interleave: number;
  isFree(img: Uint8Array, t: number, s: number): boolean;
  allocate(img: Uint8Array, t: number, s: number): void;
  release(img: Uint8Array, t: number, s: number): void;
  freeOnTrack(img: Uint8Array, t: number): number;
  format(img: Uint8Array, name: Uint8Array, id: Uint8Array): void;
  size: number;
}

const spt1541 = (t: number) => (t <= 17 ? 21 : t <= 24 ? 19 : t <= 30 ? 18 : 17);
const pad16 = (name: Uint8Array) => { const o = new Uint8Array(16).fill(0xa0); o.set(name.subarray(0, 16)); return o; };

function offsetTable(tracks: number, spt: (t: number) => number) {
  const start = [0, 0];
  for (let t = 1; t <= tracks; t++) start[t + 1] = start[t] + spt(t) * 256;
  return (t: number, s: number) => start[t] + s * 256;
}

// ---- 1541 / 1571 style BAM: [free count, 3 bitmap bytes] ----
function bam1541(off: (t: number, s: number) => number) {
  const B = off(18, 0);
  return {
    entry: (t: number) => B + t * 4,
  };
}

function makeD64(tracks: number): Geometry {
  const off = offsetTable(tracks, spt1541);
  const { entry } = bam1541(off);
  const g: Geometry = {
    kind: 'd64', tracks, spt: spt1541, offset: off,
    dirTrack: 18, firstDirSector: 1,
    header: { t: 18, s: 0, name: 0x90, id: 0xa2 },
    reserved: [18], interleave: 10,
    isFree: (img, t, s) => t <= 35 && (img[entry(t) + 1 + (s >> 3)] & (1 << (s & 7))) !== 0,
    allocate(img, t, s) { if (!g.isFree(img, t, s)) return; img[entry(t) + 1 + (s >> 3)] &= ~(1 << (s & 7)); img[entry(t)]--; },
    release(img, t, s) { if (t > 35 || s >= spt1541(t) || g.isFree(img, t, s)) return; img[entry(t) + 1 + (s >> 3)] |= 1 << (s & 7); img[entry(t)]++; },
    freeOnTrack: (img, t) => (t <= 35 ? img[entry(t)] : 0),
    format(img, name, id) {
      img.fill(0);
      const b = off(18, 0);
      img[b] = 18; img[b + 1] = 1; img[b + 2] = 0x41;
      for (let t = 1; t <= 35; t++) {
        img[entry(t)] = spt1541(t);
        for (let s = 0; s < spt1541(t); s++) img[entry(t) + 1 + (s >> 3)] |= 1 << (s & 7);
      }
      img.fill(0xa0, b + 0x90, b + 0xab);
      img.set(pad16(name), b + 0x90);
      img[b + 0xa2] = id[0] ?? 0x30; img[b + 0xa3] = id[1] ?? 0x30;
      img[b + 0xa5] = 0x32; img[b + 0xa6] = 0x41; // "2A"
      g.allocate(img, 18, 0); g.allocate(img, 18, 1);
      img[off(18, 1) + 1] = 0xff;
    },
    size: off(tracks + 1, 0),
  };
  return g;
}

function makeD71(): Geometry {
  const spt = (t: number) => spt1541(t > 35 ? t - 35 : t);
  const off = offsetTable(70, spt);
  const B = off(18, 0), B2 = off(53, 0);
  const side1 = (t: number) => B + t * 4;
  const bit = (img: Uint8Array, t: number, s: number) => (t <= 35 ? side1(t) + 1 : B2 + (t - 36) * 3) + (s >> 3);
  const count = (t: number) => (t <= 35 ? side1(t) : B + 0xdd + (t - 36));
  const g: Geometry = {
    kind: 'd71', tracks: 70, spt, offset: off,
    dirTrack: 18, firstDirSector: 1,
    header: { t: 18, s: 0, name: 0x90, id: 0xa2 },
    reserved: [18, 53], interleave: 6,
    isFree: (img, t, s) => (img[bit(img, t, s)] & (1 << (s & 7))) !== 0,
    allocate(img, t, s) { if (!g.isFree(img, t, s)) return; img[bit(img, t, s)] &= ~(1 << (s & 7)); img[count(t)]--; },
    release(img, t, s) { if (s >= spt(t) || g.isFree(img, t, s)) return; img[bit(img, t, s)] |= 1 << (s & 7); img[count(t)]++; },
    freeOnTrack: (img, t) => img[count(t)],
    format(img, name, id) {
      img.fill(0);
      img[B] = 18; img[B + 1] = 1; img[B + 2] = 0x41; img[B + 3] = 0x80; // 0x80: double sided
      for (let t = 1; t <= 70; t++) {
        img[count(t)] = spt(t);
        for (let s = 0; s < spt(t); s++) img[bit(img, t, s)] |= 1 << (s & 7);
      }
      img.fill(0xa0, B + 0x90, B + 0xab);
      img.set(pad16(name), B + 0x90);
      img[B + 0xa2] = id[0] ?? 0x30; img[B + 0xa3] = id[1] ?? 0x30;
      img[B + 0xa5] = 0x32; img[B + 0xa6] = 0x41;
      g.allocate(img, 18, 0); g.allocate(img, 18, 1);
      for (let s = 0; s < spt(53); s++) g.allocate(img, 53, s); // track 53 is reserved on a 1571
      img[off(18, 1) + 1] = 0xff;
    },
    size: off(71, 0),
  };
  return g;
}

function makeD81(): Geometry {
  const spt = () => 40;
  const off = offsetTable(80, spt);
  const H = off(40, 0), B1 = off(40, 1), B2 = off(40, 2);
  const entry = (t: number) => (t <= 40 ? B1 + 0x10 + (t - 1) * 6 : B2 + 0x10 + (t - 41) * 6);
  const g: Geometry = {
    kind: 'd81', tracks: 80, spt, offset: off,
    dirTrack: 40, firstDirSector: 3,
    header: { t: 40, s: 0, name: 0x04, id: 0x16 },
    reserved: [40], interleave: 1,
    isFree: (img, t, s) => (img[entry(t) + 1 + (s >> 3)] & (1 << (s & 7))) !== 0,
    allocate(img, t, s) { if (!g.isFree(img, t, s)) return; img[entry(t) + 1 + (s >> 3)] &= ~(1 << (s & 7)); img[entry(t)]--; },
    release(img, t, s) { if (s >= 40 || g.isFree(img, t, s)) return; img[entry(t) + 1 + (s >> 3)] |= 1 << (s & 7); img[entry(t)]++; },
    freeOnTrack: (img, t) => img[entry(t)],
    format(img, name, id) {
      img.fill(0);
      img[H] = 40; img[H + 1] = 3; img[H + 2] = 0x44; // 'D'
      img.fill(0xa0, H + 4, H + 0x1d);
      img.set(pad16(name), H + 4);
      img[H + 0x16] = id[0] ?? 0x30; img[H + 0x17] = id[1] ?? 0x30;
      img[H + 0x19] = 0x33; img[H + 0x1a] = 0x44; // "3D"
      for (const [b, next] of [[B1, [40, 2]], [B2, [0, 0xff]]] as const) {
        img[b] = next[0]; img[b + 1] = next[1];
        img[b + 2] = 0x44; img[b + 3] = 0xbb;
        img[b + 4] = id[0] ?? 0x30; img[b + 5] = id[1] ?? 0x30;
        img[b + 6] = 0xc0;
      }
      for (let t = 1; t <= 80; t++) { img[entry(t)] = 40; img.fill(0xff, entry(t) + 1, entry(t) + 6); }
      for (const s of [0, 1, 2, 3]) g.allocate(img, 40, s);
      img[off(40, 3) + 1] = 0xff;
    },
    size: off(81, 0),
  };
  return g;
}

export const D64 = makeD64(35);
const D64_40 = makeD64(40);
export const D71 = makeD71();
export const D81 = makeD81();

/** Geometry from the image size (with or without error bytes). */
export function geometryFor(img: Uint8Array): Geometry {
  const n = img.length;
  if (n >= 819200) return D81;
  if (n >= 349696) return D71;
  if (n >= 196608) return D64_40;
  return D64;
}

export function isDiskImageSize(n: number) {
  return [174848, 175531, 196608, 197376, 349696, 351062, 819200, 822400].includes(n);
}

export function blankDisk(kind: DiskKind, name: string, id: string): Uint8Array {
  const g = kind === 'd81' ? D81 : kind === 'd71' ? D71 : D64;
  const img = new Uint8Array(g.size);
  const bytes = (s: string) => Uint8Array.from(s.toUpperCase(), (c) => c.charCodeAt(0));
  g.format(img, bytes(name), bytes(id));
  return img;
}

export function freeBlocks(img: Uint8Array, g = geometryFor(img)): number {
  let n = 0;
  for (let t = 1; t <= g.tracks; t++) if (!g.reserved.includes(t)) n += g.freeOnTrack(img, t);
  return n;
}
