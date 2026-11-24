// Host keyboard → C64 keyboard matrix mapping

type Key = [number, number]; // [column (CIA1 PA bit), row (CIA1 PB bit)]
const K: Record<string, Key> = {
  DEL: [0, 0], RETURN: [0, 1], CRSR_RT: [0, 2], F7: [0, 3], F1: [0, 4], F3: [0, 5], F5: [0, 6], CRSR_DN: [0, 7],
  '3': [1, 0], W: [1, 1], A: [1, 2], '4': [1, 3], Z: [1, 4], S: [1, 5], E: [1, 6], LSHIFT: [1, 7],
  '5': [2, 0], R: [2, 1], D: [2, 2], '6': [2, 3], C: [2, 4], F: [2, 5], T: [2, 6], X: [2, 7],
  '7': [3, 0], Y: [3, 1], G: [3, 2], '8': [3, 3], B: [3, 4], H: [3, 5], U: [3, 6], V: [3, 7],
  '9': [4, 0], I: [4, 1], J: [4, 2], '0': [4, 3], M: [4, 4], K: [4, 5], O: [4, 6], N: [4, 7],
  '+': [5, 0], P: [5, 1], L: [5, 2], '-': [5, 3], '.': [5, 4], ':': [5, 5], '@': [5, 6], ',': [5, 7],
  '£': [6, 0], '*': [6, 1], ';': [6, 2], HOME: [6, 3], RSHIFT: [6, 4], '=': [6, 5], '↑': [6, 6], '/': [6, 7],
  '1': [7, 0], '←': [7, 1], CTRL: [7, 2], '2': [7, 3], SPACE: [7, 4], CBM: [7, 5], Q: [7, 6], STOP: [7, 7],
};

export type Shift = 'pass' | 'on' | 'off';
interface Mapping { keys: Key[]; shift: Shift; }
const m = (k: string, shift: Shift = 'pass'): Mapping => ({ keys: [K[k]], shift });

const SYMBOLS: Record<string, Mapping> = {
  '!': m('1', 'on'), '"': m('2', 'on'), '#': m('3', 'on'), '$': m('4', 'on'), '%': m('5', 'on'),
  '&': m('6', 'on'), "'": m('7', 'on'), '(': m('8', 'on'), ')': m('9', 'on'),
  '+': m('+', 'off'), '-': m('-', 'off'), '*': m('*', 'off'), '/': m('/', 'off'), '=': m('=', 'off'),
  ':': m(':', 'off'), ';': m(';', 'off'), '@': m('@', 'off'), ',': m(',', 'off'), '.': m('.', 'off'),
  '<': m(',', 'on'), '>': m('.', 'on'), '?': m('/', 'on'), '[': m(':', 'on'), ']': m(';', 'on'),
  '^': m('↑', 'off'), '£': m('£', 'off'), '\\': m('£', 'off'), '_': m('←', 'off'), '`': m('←', 'off'),
  '0': m('0', 'off'), '1': m('1', 'off'), '2': m('2', 'off'), '3': m('3', 'off'), '4': m('4', 'off'),
  '5': m('5', 'off'), '6': m('6', 'off'), '7': m('7', 'off'), '8': m('8', 'off'), '9': m('9', 'off'),
};

const CODES: Record<string, Mapping> = {
  Enter: m('RETURN'), NumpadEnter: m('RETURN'), Backspace: m('DEL'), Delete: m('DEL'),
  Insert: m('DEL', 'on'), Home: m('HOME'), Escape: m('STOP'), Tab: m('CTRL'),
  ArrowRight: m('CRSR_RT', 'off'), ArrowLeft: m('CRSR_RT', 'on'),
  ArrowDown: m('CRSR_DN', 'off'), ArrowUp: m('CRSR_DN', 'on'),
  ShiftLeft: m('LSHIFT'), ShiftRight: m('RSHIFT'),
  ControlLeft: m('CBM'), ControlRight: m('CBM'), AltLeft: m('CBM'),
  F1: m('F1', 'off'), F2: m('F1', 'on'), F3: m('F3', 'off'), F4: m('F3', 'on'),
  F5: m('F5', 'off'), F6: m('F5', 'on'), F7: m('F7', 'off'), F8: m('F7', 'on'),
  Space: m('SPACE'),
};

export const JOY_KEYS: Record<string, number> = {
  ArrowUp: 1, ArrowDown: 2, ArrowLeft: 4, ArrowRight: 8,
  Numpad8: 1, Numpad2: 2, Numpad4: 4, Numpad6: 8,
  ControlLeft: 16, ControlRight: 16, AltLeft: 16, AltRight: 16, Numpad0: 16, Numpad5: 16,
};

export class KeyboardMapper {
  private down = new Map<string, Mapping>();
  private order: string[] = [];
  private downFrame = new Map<string, number>();
  private queue: { code: string; map: Mapping | null }[] = [];
  private frame = 0;

  private resolve(e: KeyboardEvent): Mapping | undefined {
    if (e.code.startsWith('Key') && e.code.length === 4) return m(e.code[3]);
    if (e.code.startsWith('Digit') && !e.shiftKey) return m(e.code[5], 'off');
    return CODES[e.code] ?? SYMBOLS[e.key];
  }

  /** Returns true if the event was handled. Events are queued so every key is held for at least two frames. */
  keyDown(e: KeyboardEvent): boolean {
    if (e.metaKey) return false;
    const map = this.resolve(e);
    if (!map) return false;
    if (!e.repeat) this.queue.push({ code: e.code, map });
    return true;
  }
  keyUp(e: KeyboardEvent): boolean {
    const known = this.down.has(e.code) || this.queue.some((q) => q.code === e.code && q.map);
    if (!known) return false;
    this.queue.push({ code: e.code, map: null });
    return true;
  }
  /** Press / release a C64 key from an on-screen button (`key` is a matrix key name such as SPACE or F1). */
  virtualDown(id: string, key: string, shift: Shift = 'off') {
    if (!K[key]) return;
    this.queue.push({ code: 'v:' + id, map: m(key, shift) });
  }
  virtualUp(id: string) {
    this.queue.push({ code: 'v:' + id, map: null });
  }
  releaseAll() { this.down.clear(); this.order = []; this.queue = []; }

  /** Call once per emulated frame: applies queued events and writes the C64 key matrix. */
  apply(matrix: Uint8Array) {
    this.frame++;
    let pressedThisFrame = false;
    while (this.queue.length) {
      const ev = this.queue[0];
      if (ev.map) {
        if (pressedThisFrame) break;
        this.down.set(ev.code, ev.map);
        this.downFrame.set(ev.code, this.frame);
        this.order = this.order.filter((c) => c !== ev.code);
        this.order.push(ev.code);
        pressedThisFrame = true;
      } else {
        if (this.frame - (this.downFrame.get(ev.code) ?? -99) < 3) break;
        this.down.delete(ev.code);
        this.order = this.order.filter((c) => c !== ev.code);
      }
      this.queue.shift();
    }
    matrix.fill(0);
    let override: Shift = 'pass';
    for (const code of this.order) {
      const mp = this.down.get(code)!;
      for (const [col, row] of mp.keys) matrix[col] |= 1 << row;
      if (mp.shift !== 'pass') override = mp.shift;
    }
    const [lc, lr] = K.LSHIFT, [rc, rr] = K.RSHIFT;
    if (override === 'off') { matrix[lc] &= ~(1 << lr); matrix[rc] &= ~(1 << rr); }
    else if (override === 'on') matrix[lc] |= 1 << lr;
  }
}
