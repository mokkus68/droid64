// Build .CRT images for tests
/** Build a .CRT image: chips = [{bank, load, data}] */
export function buildCrt(type: number, exrom: number, game: number, name: string, chips: { bank: number; load: number; data: number[] | Uint8Array }[]) {
  const parts: number[] = [];
  const hdr = new Uint8Array(0x40);
  hdr.set(Array.from('C64 CARTRIDGE   ', (c) => c.charCodeAt(0)), 0);
  hdr.set([0, 0, 0, 0x40, 1, 0, type >> 8, type & 255, exrom, game], 0x10);
  hdr.set(Array.from(name, (c) => c.charCodeAt(0)), 0x20);
  parts.push(...hdr);
  for (const c of chips) {
    const size = c.data.length, plen = size + 16;
    parts.push(...Array.from('CHIP', (ch) => ch.charCodeAt(0)), plen >>> 24, (plen >> 16) & 255, (plen >> 8) & 255, plen & 255,
      0, 0, c.bank >> 8, c.bank & 255, c.load >> 8, c.load & 255, size >> 8, size & 255, ...c.data);
  }
  return new Uint8Array(parts);
}
