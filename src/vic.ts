// MOS 6569 VIC-II (PAL), line-based renderer

export const SCREEN_W = 384;
export const SCREEN_H = 272;
export const FIRST_VISIBLE_LINE = 16;
export const LINES_PER_FRAME = 312;
export const CYCLES_PER_LINE = 63;

const PALETTE_RGB = [
  0x000000, 0xffffff, 0x813338, 0x75cec8, 0x8e3c97, 0x56ac4d, 0x2e2c9b, 0xedf171,
  0x8e5029, 0x553800, 0xc46c71, 0x4a4a4a, 0x7b7b7b, 0xa9ff9f, 0x706deb, 0xb2b2b2,
];
// ABGR for little-endian ImageData
export const PALETTE = new Uint32Array(PALETTE_RGB.map((c) =>
  (0xff000000 | ((c & 0xff) << 16) | (c & 0xff00) | ((c >> 16) & 0xff)) >>> 0));

export interface VicMemory {
  /** Read a byte as seen by the VIC (14-bit address within the current bank). */
  vicRead(addr: number): number;
  colorRam: Uint8Array;
}

export class VIC {
  regs = new Uint8Array(64);
  raster = 0;
  rasterCompare = 0;
  irqFlags = 0;
  irqMask = 0;
  sprSprColl = 0;
  sprBgColl = 0;
  frameBuffer = new Uint32Array(SCREEN_W * SCREEN_H);
  onIrq: (active: boolean) => void = () => {};

  private vBorder = true;
  private displayEnabledThisFrame = false;
  private fgMask = new Uint8Array(SCREEN_W + 64);
  private lineColor = new Uint8Array(SCREEN_W + 64);
  private sprOwner = new Int8Array(SCREEN_W + 64);
  private sprColor = new Uint8Array(SCREEN_W + 64);
  private sprOcc = new Uint8Array(SCREEN_W + 64);
  // sprite Y-expansion flip-flop / current line counters
  constructor(private mem: VicMemory) {}

  reset() {
    this.regs.fill(0);
    this.raster = 0; this.rasterCompare = 0; this.irqFlags = 0; this.irqMask = 0;
    this.sprSprColl = 0; this.sprBgColl = 0;
    this.updateIrq();
  }

  private updateIrq() {
    if (this.irqFlags & this.irqMask & 0x0f) { this.irqFlags |= 0x80; this.onIrq(true); }
    else { this.irqFlags &= 0x7f; this.onIrq(false); }
  }
  private raiseIrq(bit: number) { this.irqFlags |= bit; this.updateIrq(); }

  read(reg: number): number {
    reg &= 0x3f;
    const r = this.regs;
    switch (reg) {
      case 0x11: return (r[0x11] & 0x7f) | ((this.raster & 0x100) >> 1);
      case 0x12: return this.raster & 0xff;
      case 0x13: case 0x14: return 0;
      case 0x16: return r[0x16] | 0xc0;
      case 0x18: return r[0x18] | 0x01;
      case 0x19: return this.irqFlags | 0x70;
      case 0x1a: return this.irqMask | 0xf0;
      case 0x1e: { const v = this.sprSprColl; this.sprSprColl = 0; return v; }
      case 0x1f: { const v = this.sprBgColl; this.sprBgColl = 0; return v; }
    }
    if (reg >= 0x20 && reg <= 0x2e) return r[reg] | 0xf0;
    if (reg >= 0x2f) return 0xff;
    return r[reg];
  }

  write(reg: number, v: number) {
    reg &= 0x3f;
    switch (reg) {
      case 0x11:
        this.regs[0x11] = v;
        this.setCompare((this.rasterCompare & 0xff) | ((v & 0x80) << 1));
        return;
      case 0x12:
        this.setCompare((this.rasterCompare & 0x100) | v);
        return;
      case 0x19: this.irqFlags &= ~(v & 0x0f); this.updateIrq(); return;
      case 0x1a: this.irqMask = v & 0x0f; this.updateIrq(); return;
      case 0x1e: case 0x1f: return;
    }
    this.regs[reg] = v;
  }

  private setCompare(c: number) {
    const old = this.rasterCompare;
    this.rasterCompare = c;
    if (c !== old && c === this.raster) this.raiseIrq(1);
  }

  /** Called at the start of each raster line; returns number of cycles stolen from the CPU. */
  startLine(): number {
    const raster = this.raster;
    if (raster === this.rasterCompare) this.raiseIrq(1);
    const ctrl1 = this.regs[0x11];
    if (raster === 0x30 && (ctrl1 & 0x10)) this.displayEnabledThisFrame = true;
    let stolen = 0;
    if (this.isBadLine()) stolen += 40;
    // sprite DMA
    const en = this.regs[0x15];
    if (en) {
      for (let i = 0; i < 8; i++) {
        if (!(en & (1 << i))) continue;
        const h = (this.regs[0x17] & (1 << i)) ? 42 : 21;
        const rel = (raster - this.regs[i * 2 + 1]) & 0x1ff;
        if (rel < h) stolen += 2;
      }
    }
    return stolen;
  }

  isBadLine(): boolean {
    const raster = this.raster;
    return this.displayEnabledThisFrame && raster >= 0x30 && raster <= 0xf7 && (raster & 7) === (this.regs[0x11] & 7);
  }

  /** Render the current raster line and advance to the next. Returns true at end of frame. */
  endLine(): boolean {
    const raster = this.raster;
    const r = this.regs;
    const ctrl1 = r[0x11];
    const rsel = ctrl1 & 8;
    // vertical border flip-flop
    if (raster === (rsel ? 251 : 247)) this.vBorder = true;
    if (raster === (rsel ? 51 : 55) && (ctrl1 & 0x10)) this.vBorder = false;

    const fbY = raster - FIRST_VISIBLE_LINE;
    if (fbY >= 0 && fbY < SCREEN_H) this.renderLine(raster, fbY);

    this.raster++;
    if (this.raster >= LINES_PER_FRAME) {
      this.raster = 0;
      this.displayEnabledThisFrame = false;
      return true;
    }
    return false;
  }

  private renderLine(raster: number, fbY: number) {
    const r = this.regs;
    const mem = this.mem;
    const ctrl1 = r[0x11], ctrl2 = r[0x16];
    const line = this.lineColor, fg = this.fgMask;
    const bg0 = r[0x21] & 15;
    const borderColor = r[0x20] & 15;
    const out = this.frameBuffer;
    const base = fbY * SCREEN_W;

    if (this.vBorder) {
      // whole line is border; sprites hidden behind border
      const c = PALETTE[borderColor];
      for (let x = 0; x < SCREEN_W; x++) out[base + x] = c;
      return;
    }

    line.fill(bg0, 0, SCREEN_W);
    fg.fill(0, 0, SCREEN_W + 64);

    const yscroll = ctrl1 & 7;
    const py = raster - 0x30 - yscroll;
    if (this.displayEnabledThisFrame && py >= 0 && py < 200) {
      const xscroll = ctrl2 & 7;
      const ecm = ctrl1 & 0x40, bmm = ctrl1 & 0x20, mcm = ctrl2 & 0x10;
      const d018 = r[0x18];
      const screenBase = (d018 & 0xf0) << 6;
      const charBase = (d018 & 0x0e) << 10;
      const bitmapBase = (d018 & 0x08) << 10;
      const row = py >> 3, cy = py & 7;
      const cram = mem.colorRam;
      let x = 32 + xscroll;
      const bg1 = r[0x22] & 15, bg2 = r[0x23] & 15, bg3 = r[0x24] & 15;
      const invalid = (ecm && (bmm || mcm));
      for (let col = 0; col < 40; col++, x += 8) {
        const off = row * 40 + col;
        const scr = mem.vicRead(screenBase + off);
        const color = cram[off] & 15;
        let data: number;
        if (bmm) data = mem.vicRead(bitmapBase + off * 8 + cy);
        else data = mem.vicRead(charBase + ((ecm ? scr & 0x3f : scr) << 3) + cy);
        if (invalid) {
          // invalid modes show black but still produce foreground for collisions
          if (mcm) {
            for (let p = 0; p < 8; p += 2) {
              const bits = (data >> (6 - p)) & 3;
              line[x + p] = line[x + p + 1] = 0;
              if (bits & 2) fg[x + p] = fg[x + p + 1] = 1;
            }
          } else {
            for (let p = 0; p < 8; p++) { line[x + p] = 0; if (data & (0x80 >> p)) fg[x + p] = 1; }
          }
          continue;
        }
        if (bmm) {
          if (mcm) {
            for (let p = 0; p < 8; p += 2) {
              const bits = (data >> (6 - p)) & 3;
              const c = bits === 0 ? bg0 : bits === 1 ? (scr >> 4) : bits === 2 ? (scr & 15) : color;
              line[x + p] = line[x + p + 1] = c;
              if (bits & 2) fg[x + p] = fg[x + p + 1] = 1;
            }
          } else {
            const c1 = scr >> 4, c0 = scr & 15;
            for (let p = 0; p < 8; p++) {
              if (data & (0x80 >> p)) { line[x + p] = c1; fg[x + p] = 1; } else line[x + p] = c0;
            }
          }
        } else if (mcm && (color & 8)) {
          const c3 = color & 7;
          for (let p = 0; p < 8; p += 2) {
            const bits = (data >> (6 - p)) & 3;
            const c = bits === 0 ? bg0 : bits === 1 ? bg1 : bits === 2 ? bg2 : c3;
            line[x + p] = line[x + p + 1] = c;
            if (bits & 2) fg[x + p] = fg[x + p + 1] = 1;
          }
        } else {
          const fc = mcm ? color & 7 : color;
          const bc = ecm ? [bg0, bg1, bg2, bg3][scr >> 6] : bg0;
          for (let p = 0; p < 8; p++) {
            if (data & (0x80 >> p)) { line[x + p] = fc; fg[x + p] = 1; } else line[x + p] = bc;
          }
        }
      }
      // pixels shifted past the right edge of the 40 columns are clipped by the border below
    }

    // sprites
    const en = r[0x15];
    if (en) this.renderSprites(raster, en); else this.sprOwner.fill(-1);

    // compose with horizontal border
    const csel = ctrl2 & 8;
    const left = csel ? 32 : 39, right = csel ? 352 : 343;
    const bc = PALETTE[borderColor];
    const owner = this.sprOwner, scol = this.sprColor;
    const prio = r[0x1b];
    for (let x = 0; x < SCREEN_W; x++) {
      if (x < left || x >= right) { out[base + x] = bc; continue; }
      const o = owner[x];
      if (o >= 0 && !((prio >> o) & 1 && fg[x])) out[base + x] = PALETTE[scol[x]];
      else out[base + x] = PALETTE[line[x]];
    }
  }

  private renderSprites(raster: number, en: number) {
    const r = this.regs, mem = this.mem;
    const owner = this.sprOwner, scol = this.sprColor, occ = this.sprOcc, fg = this.fgMask;
    owner.fill(-1); occ.fill(0);
    const screenBase = (r[0x18] & 0xf0) << 6;
    const mc0 = r[0x25] & 15, mc1 = r[0x26] & 15;
    let any = false;
    for (let i = 0; i < 8; i++) {
      const bit = 1 << i;
      if (!(en & bit)) continue;
      const yexp = r[0x17] & bit;
      const h = yexp ? 42 : 21;
      let rel = (raster - r[i * 2 + 1]) & 0x1ff;
      if (rel >= h) continue;
      if (yexp) rel >>= 1;
      const ptr = mem.vicRead(screenBase + 0x3f8 + i);
      const addr = ptr * 64 + rel * 3;
      const data = (mem.vicRead(addr) << 16) | (mem.vicRead(addr + 1) << 8) | mem.vicRead(addr + 2);
      if (!data) continue;
      const sx = r[i * 2] | ((r[0x10] & bit) ? 256 : 0);
      let x0 = sx + 8; // to framebuffer coords
      if (sx >= 0x1f8) x0 = sx - 504 + 8; // wrap (504 wide line)
      const xexp = r[0x1d] & bit;
      const color = r[0x27 + i] & 15;
      const multi = r[0x1c] & bit;
      const pw = xexp ? 2 : 1;
      any = true;
      if (multi) {
        for (let p = 0; p < 12; p++) {
          const bits = (data >> (22 - p * 2)) & 3;
          if (!bits) continue;
          const c = bits === 1 ? mc0 : bits === 2 ? color : mc1;
          for (let k = 0; k < 2 * pw; k++) {
            const x = x0 + p * 2 * pw + k;
            if (x < 0 || x >= SCREEN_W) continue;
            occ[x] |= bit;
            if (owner[x] < 0) { owner[x] = i; scol[x] = c; }
          }
        }
      } else {
        for (let p = 0; p < 24; p++) {
          if (!((data >> (23 - p)) & 1)) continue;
          for (let k = 0; k < pw; k++) {
            const x = x0 + p * pw + k;
            if (x < 0 || x >= SCREEN_W) continue;
            occ[x] |= bit;
            if (owner[x] < 0) { owner[x] = i; scol[x] = color; }
          }
        }
      }
    }
    if (!any) return;
    let ss = 0, sb = 0;
    for (let x = 0; x < SCREEN_W; x++) {
      const o = occ[x];
      if (!o) continue;
      if (o & (o - 1)) ss |= o;
      if (fg[x]) sb |= o;
    }
    if (ss) { if (!this.sprSprColl) this.raiseIrq(4); this.sprSprColl |= ss; }
    if (sb) { if (!this.sprBgColl) this.raiseIrq(2); this.sprBgColl |= sb; }
  }
}
