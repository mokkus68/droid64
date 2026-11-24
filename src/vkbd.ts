// On-screen C64 keyboard (touch / mouse), laid out like the breadbin keyboard

export interface VKey {
  label: string;          // main legend
  top?: string;           // shifted legend printed above
  key?: string;           // matrix key name (see keyboard.ts)
  w?: number;             // relative width
  cls?: string;           // style variant
  mod?: 'shift' | 'lock' | 'cbm' | 'ctrl';
  forceShift?: boolean;   // e.g. cursor up / left
  action?: 'restore';
  aria?: string;
}

const k = (label: string, key: string, top?: string, w?: number, cls?: string): VKey => ({ label, key, top, w, cls });

export const ROWS: VKey[][] = [
  [
    { ...k('F1', 'F1', 'F2'), cls: 'fn' }, { ...k('F3', 'F3', 'F4'), cls: 'fn' },
    { ...k('F5', 'F5', 'F6'), cls: 'fn' }, { ...k('F7', 'F7', 'F8'), cls: 'fn' },
    { ...k('RUN\nSTOP', 'STOP'), aria: 'Run/Stop' }, { label: 'RE-\nSTORE', action: 'restore', aria: 'Restore' },
    { ...k('CLR\nHOME', 'HOME'), aria: 'Clr/Home' }, { ...k('INST\nDEL', 'DEL'), aria: 'Inst/Del' },
  ],
  [
    k('←', '←'), k('1', '1', '!'), k('2', '2', '"'), k('3', '3', '#'), k('4', '4', '$'), k('5', '5', '%'),
    k('6', '6', '&'), k('7', '7', "'"), k('8', '8', '('), k('9', '9', ')'), k('0', '0'),
    k('+', '+'), k('−', '-'), k('£', '£'),
  ],
  [
    { label: 'CTRL', mod: 'ctrl', w: 1.3, cls: 'mod' },
    k('Q', 'Q'), k('W', 'W'), k('E', 'E'), k('R', 'R'), k('T', 'T'), k('Y', 'Y'), k('U', 'U'),
    k('I', 'I'), k('O', 'O'), k('P', 'P'), k('@', '@'), k('*', '*'), k('↑', '↑', 'π'),
  ],
  [
    { label: 'SHIFT\nLOCK', mod: 'lock', w: 1.3, cls: 'mod', aria: 'Shift Lock' },
    k('A', 'A'), k('S', 'S'), k('D', 'D'), k('F', 'F'), k('G', 'G'), k('H', 'H'), k('J', 'J'),
    k('K', 'K'), k('L', 'L'), k(':', ':', '['), k(';', ';', ']'), k('=', '='),
    { ...k('RETURN', 'RETURN'), w: 1.7, cls: 'wide' },
  ],
  [
    { label: 'C=', mod: 'cbm', cls: 'mod', aria: 'Commodore' },
    { label: 'SHIFT', mod: 'shift', w: 1.5, cls: 'mod' },
    k('Z', 'Z'), k('X', 'X'), k('C', 'C'), k('V', 'V'), k('B', 'B'), k('N', 'N'), k('M', 'M'),
    k(',', ',', '<'), k('.', '.', '>'), k('/', '/', '?'),
    { label: 'SHIFT', mod: 'shift', w: 1.5, cls: 'mod' },
  ],
  [
    { label: '←', key: 'CRSR_RT', forceShift: true, cls: 'crsr', aria: 'Cursore a sinistra' },
    { label: '↑', key: 'CRSR_DN', forceShift: true, cls: 'crsr', aria: 'Cursore su' },
    { label: '', key: 'SPACE', w: 8, cls: 'space', aria: 'Spazio' },
    { label: '↓', key: 'CRSR_DN', cls: 'crsr', aria: 'Cursore giù' },
    { label: '→', key: 'CRSR_RT', cls: 'crsr', aria: 'Cursore a destra' },
  ],
];

export interface VKeyboardHost {
  down(id: string, keys: string[]): void;
  up(id: string): void;
  restore(): void;
  touched(): void; // first interaction: start audio etc.
}

export function buildKeyboard(root: HTMLElement, host: VKeyboardHost) {
  const mods = { shift: false, lock: false, cbm: false, ctrl: false };
  const modButtons: { el: HTMLButtonElement; mod: string }[] = [];
  const refresh = () => {
    for (const { el, mod } of modButtons) {
      const on = (mods as any)[mod];
      el.setAttribute('aria-pressed', String(on));
    }
    root.dataset.shift = mods.shift || mods.lock ? '1' : '0';
  };
  const buzz = () => { try { navigator.vibrate?.(6); } catch { /* not supported */ } };

  let n = 0;
  for (const row of ROWS) {
    const r = document.createElement('div');
    r.className = 'vk-row';
    for (const def of row) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'vk' + (def.cls ? ' ' + def.cls : '');
      b.style.flexGrow = String(def.w ?? 1);
      b.setAttribute('aria-label', def.aria ?? def.label.replace('\n', ' '));
      if (def.top) { const t = document.createElement('span'); t.className = 'top'; t.textContent = def.top; b.append(t); }
      const m = document.createElement('span'); m.className = 'main'; m.textContent = def.label; b.append(m);
      const id = 'vk' + n++;

      if (def.mod) {
        modButtons.push({ el: b, mod: def.mod });
        b.setAttribute('aria-pressed', 'false');
        b.addEventListener('pointerdown', (e) => {
          e.preventDefault(); host.touched(); buzz();
          if (def.mod === 'lock') { mods.lock = !mods.lock; mods.shift = false; }
          else (mods as any)[def.mod!] = !(mods as any)[def.mod!];
          refresh();
        });
      } else {
        let held = false;
        const release = () => {
          if (!held) return;
          held = false; b.dataset.down = '0';
          if (def.key) host.up(id);
        };
        b.addEventListener('pointerdown', (e) => {
          e.preventDefault(); host.touched(); buzz();
          try { b.setPointerCapture(e.pointerId); } catch { /* ignore */ }
          if (def.action === 'restore') { host.restore(); b.dataset.down = '1'; setTimeout(() => { b.dataset.down = '0'; }, 150); return; }
          if (!def.key) return;
          held = true; b.dataset.down = '1';
          const keys = [def.key];
          if (mods.shift || mods.lock || def.forceShift) keys.push('LSHIFT');
          if (mods.cbm) keys.push('CBM');
          if (mods.ctrl) keys.push('CTRL');
          host.down(id, keys);
          // one-shot modifiers apply to a single key
          if (mods.shift || mods.cbm || mods.ctrl) { mods.shift = mods.cbm = mods.ctrl = false; refresh(); }
        });
        b.addEventListener('pointerup', release);
        b.addEventListener('pointercancel', release);
      }
      b.addEventListener('contextmenu', (e) => e.preventDefault());
      r.append(b);
    }
    root.append(r);
  }
  refresh();
}
