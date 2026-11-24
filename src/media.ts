// Disk / tape image parsing (D64, T64, PRG)

export interface DiskFile { name: string; rawName: Uint8Array; type: string; blocks: number; data: Uint8Array | null; }
export interface DiskImage { title: string; id: string; files: DiskFile[]; freeBlocks: number; }

const SECTORS = (t: number) => (t <= 17 ? 21 : t <= 24 ? 19 : t <= 30 ? 18 : 17);

function trackOffset(track: number): number {
  let off = 0;
  for (let t = 1; t < track; t++) off += SECTORS(t) * 256;
  return off;
}

export function petsciiToAscii(code: number): string {
  if (code >= 0x41 && code <= 0x5a) return String.fromCharCode(code);
  if (code >= 0xc1 && code <= 0xda) return String.fromCharCode(code - 0x80);
  if (code >= 0x20 && code <= 0x3f) return String.fromCharCode(code);
  if (code === 0x5c) return '£';
  if (code === 0x5e) return '↑';
  if (code === 0x5f) return '←';
  return '·';
}

function readName(bytes: Uint8Array, off: number, len: number): Uint8Array {
  let end = off + len;
  while (end > off && bytes[end - 1] === 0xa0) end--;
  return bytes.slice(off, end);
}

export const nameToString = (n: Uint8Array) => Array.from(n, petsciiToAscii).join('');

export type D64File = DiskFile;

export function parseD64(img: Uint8Array): DiskImage & { files: D64File[] } {
  const sector = (t: number, s: number) => trackOffset(t) + s * 256;
  const maxTrack = img.length >= 196608 ? 40 : 35;
  const bam = sector(18, 0);
  const title = nameToString(readName(img, bam + 0x90, 16));
  const id = nameToString(img.slice(bam + 0xa2, bam + 0xa7));
  let free = 0;
  for (let t = 1; t <= 35; t++) if (t !== 18) free += img[bam + t * 4];

  const readChain = (t: number, s: number): Uint8Array => {
    const chunks: number[] = [];
    const seen = new Set<string>();
    while (t !== 0 && t <= maxTrack) {
      const key = `${t}/${s}`;
      if (seen.has(key)) break;
      seen.add(key);
      const off = sector(t, s);
      if (off + 256 > img.length) break;
      const nt = img[off], ns = img[off + 1];
      const last = nt === 0 ? ns : 255;
      for (let i = 2; i <= last; i++) chunks.push(img[off + i]);
      t = nt; s = ns;
    }
    return new Uint8Array(chunks);
  };

  const files: D64File[] = [];
  let t = 18, s = 1;
  const seen = new Set<string>();
  while (t !== 0 && !seen.has(`${t}/${s}`)) {
    seen.add(`${t}/${s}`);
    const off = sector(t, s);
    if (off + 256 > img.length) break;
    for (let e = 0; e < 8; e++) {
      const eo = off + e * 32;
      const type = img[eo + 2];
      if ((type & 7) === 0 && !(type & 0x80)) continue;
      if (type === 0) continue;
      const rawName = readName(img, eo + 5, 16);
      const typeName = ['DEL', 'SEQ', 'PRG', 'USR', 'REL'][type & 7] ?? '???';
      const blocks = img[eo + 30] | (img[eo + 31] << 8);
      files.push({
        name: nameToString(rawName), rawName, type: typeName, blocks,
        data: (type & 7) === 2 ? readChain(img[eo + 3], img[eo + 4]) : null,
      });
    }
    t = img[off]; s = img[off + 1];
  }
  return { title, id, files, freeBlocks: free };
}

export function parseT64(img: Uint8Array): DiskImage & { files: D64File[] } {
  const dv = new DataView(img.buffer, img.byteOffset, img.byteLength);
  const maxEntries = dv.getUint16(0x22, true);
  const title = nameToString(readName(img, 0x28, 24).map((c) => (c === 0x20 ? 0x20 : c)));
  const entries: { start: number; end: number; offset: number; rawName: Uint8Array; type: number }[] = [];
  for (let i = 0; i < Math.max(1, maxEntries); i++) {
    const eo = 0x40 + i * 32;
    if (eo + 32 > img.length) break;
    if (img[eo] === 0) continue;
    entries.push({
      type: img[eo + 1],
      start: dv.getUint16(eo + 2, true), end: dv.getUint16(eo + 4, true),
      offset: dv.getUint32(eo + 8, true),
      rawName: readName(img, eo + 16, 16).map((c) => (c === 0x20 ? 0xa0 : c)),
    });
  }
  const files: D64File[] = entries.map((e) => {
    let len = (e.end - e.start) & 0xffff;
    if (e.offset + len > img.length || len === 0) len = img.length - e.offset; // fix broken end addresses
    const data = new Uint8Array(len + 2);
    data[0] = e.start & 0xff; data[1] = e.start >> 8;
    data.set(img.slice(e.offset, e.offset + len), 2);
    const rawName = readName(e.rawName, 0, e.rawName.length);
    return { name: nameToString(rawName).trim(), rawName, type: 'PRG', blocks: Math.ceil(len / 254), data };
  });
  return { title, id: 'T64', files, freeBlocks: 0 };
}

/** CBM wildcard filename matching ("*" and "?"). */
export function matchName(pattern: Uint8Array, name: Uint8Array): boolean {
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i];
    if (p === 0x2a) return true;
    if (i >= name.length) return false;
    if (p !== 0x3f && p !== name[i]) return false;
  }
  return pattern.length === name.length;
}

/** Build a BASIC program listing a disk directory (as LOAD"$",8 does). */
export function buildDirectoryListing(disk: DiskImage & { files: D64File[] }, loadAddr = 0x0801): Uint8Array {
  const out: number[] = [loadAddr & 0xff, loadAddr >> 8];
  let addr = loadAddr;
  const line = (num: number, bytes: number[]) => {
    const next = addr + 4 + bytes.length + 1;
    out.push(next & 0xff, next >> 8, num & 0xff, num >> 8, ...bytes, 0);
    addr = next;
  };
  const str = (s: string) => Array.from(s, (ch) => ch.charCodeAt(0) & 0xff);
  line(0, [0x12, 0x22, ...str(disk.title.padEnd(16, ' ')), 0x22, 0x20, ...str(disk.id)]);
  for (const f of disk.files) {
    const blocks = String(f.blocks);
    const pad = ' '.repeat(Math.max(0, 4 - blocks.length));
    const name = Array.from(f.rawName);
    const quoted = [0x22, ...name, 0x22];
    const spaces = ' '.repeat(Math.max(1, 18 - quoted.length + 1));
    line(f.blocks, [...str(pad), ...quoted, ...str(spaces + f.type)]);
  }
  line(disk.freeBlocks, str('BLOCKS FREE.'));
  out.push(0, 0);
  return new Uint8Array(out);
}
