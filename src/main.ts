import { C64, Roms, FRAME_HZ } from './c64';
import { SCREEN_W, SCREEN_H, PALETTE } from './vic';
import { KeyboardMapper, JOY_KEYS } from './keyboard';
import { parseD64, parseT64, D64File, DiskImage } from './media';
import { OPEN_BASIC, OPEN_KERNAL, OPEN_CHARGEN } from './roms';
import { DEMO } from './demo';
import { buildKeyboard } from './vkbd';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const b64ToBytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const bytesToB64 = (b: Uint8Array) => { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); };
const store = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  del(k: string) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
};

// ---------- ROMs ----------
interface UserRoms { basic?: string; kernal?: string; chargen?: string; }
let userRoms: UserRoms = {};
try { userRoms = JSON.parse(store.get('c64.roms') || '{}'); } catch { userRoms = {}; }

function currentRoms(): { roms: Roms; original: boolean } {
  const original = !!(userRoms.basic && userRoms.kernal);
  return {
    original,
    roms: {
      basic: b64ToBytes(original ? userRoms.basic! : OPEN_BASIC),
      kernal: b64ToBytes(original ? userRoms.kernal! : OPEN_KERNAL),
      chargen: b64ToBytes(userRoms.chargen ?? OPEN_CHARGEN),
    },
  };
}

function identifyRom(d: Uint8Array): keyof UserRoms | null {
  if (d.length === 4096) return 'chargen';
  if (d.length !== 8192) return null;
  const vec = (o: number) => d[o] | (d[o + 1] << 8);
  const isKernal = [0x1ffa, 0x1ffc, 0x1ffe].every((o) => vec(o) >= 0xe000);
  const sig = String.fromCharCode(...d.subarray(4, 12));
  if (sig === 'CBMBASIC') return 'basic';
  return isKernal ? 'kernal' : 'basic';
}

// ---------- machine ----------
let romInfo = currentRoms();
let c64 = new C64(romInfo.roms);

const canvas = $<HTMLCanvasElement>('screen');
const ctx = canvas.getContext('2d')!;
canvas.width = SCREEN_W; canvas.height = SCREEN_H;
const image = ctx.createImageData(SCREEN_W, SCREEN_H);
const pixels = new Uint32Array(image.data.buffer);

function draw() {
  pixels.set(c64.vic.frameBuffer);
  ctx.putImageData(image, 0, 0);
}

function rebuildMachine() {
  romInfo = currentRoms();
  c64 = new C64(romInfo.roms, audio ? audio.ctx.sampleRate : 44100);
  if (disk) c64.mountDisk(disk);
  c64.onDiskLoad = onDiskLoad;
  updateRomStatus();
}

// ---------- audio ----------
let audio: { ctx: AudioContext; gain: GainNode; node: ScriptProcessorNode } | null = null;
let volume = Number(store.get('c64.volume') ?? '0.7');
function startAudio() {
  if (audio) { if (audio.ctx.state === 'suspended') audio.ctx.resume(); return; }
  try {
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    const ctxA: AudioContext = new AC();
    const node = ctxA.createScriptProcessor(1024, 0, 1);
    const gain = ctxA.createGain();
    gain.gain.value = volume;
    node.onaudioprocess = (ev) => {
      const out = ev.outputBuffer.getChannelData(0);
      if (paused || turbo) { out.fill(0); return; }
      c64.sid.pull(out);
    };
    node.connect(gain); gain.connect(ctxA.destination);
    audio = { ctx: ctxA, gain, node };
    c64.sid.setSampleRate(ctxA.sampleRate);
    c64.sid.readPos = c64.sid.writePos;
    updateAudioStatus();
  } catch {
    audio = null;
  }
}
function updateAudioStatus() {
  $('audio-state').textContent = audio && audio.ctx.state === 'running' ? 'Audio attivo' : 'Audio spento: clicca lo schermo';
  $('audio-state').dataset.on = audio && audio.ctx.state === 'running' ? '1' : '0';
}

// ---------- main loop ----------
let paused = false, turbo = false;
let lastTime = performance.now(), acc = 0;
const frameMs = 1000 / FRAME_HZ;

let framesRun = 0;
function step() {
  keyboard.apply(c64.keys);
  c64.runFrame();
  framesRun++;
}

function loop(now: number) {
  const dt = Math.min(now - lastTime, 100);
  lastTime = now;
  if (!paused) {
    pollGamepad();
    if (turbo) {
      const t0 = performance.now();
      let n = 0;
      while (performance.now() - t0 < 14 && n < 40) { step(); n++; }
      c64.sid.readPos = c64.sid.writePos;
    } else if (audio && audio.ctx.state === 'running') {
      // pace emulation by the audio clock: keep ~3 frames of samples buffered
      const target = audio.ctx.sampleRate * 0.06 + 1024;
      let n = 0;
      while (c64.sid.available() < target && n < 4) { step(); n++; }
    } else {
      acc += dt;
      let n = 0;
      while (acc >= frameMs && n < 4) { step(); acc -= frameMs; n++; }
      if (n === 4) acc = 0;
    }
    draw();
    updateLeds();
  }
  requestAnimationFrame(loop);
}

// ---------- input ----------
const keyboard = new KeyboardMapper();
let joyPort = Number(store.get('c64.joyport') ?? '2');
let keyJoy = 0, padJoy = 0, touchJoy = 0;
const screenWrap = $('screen-wrap');

function applyJoy() {
  const v = keyJoy | padJoy | touchJoy;
  c64.joy1 = joyPort === 1 ? v : 0;
  c64.joy2 = joyPort === 2 ? v : 0;
}

screenWrap.addEventListener('keydown', (e) => {
  if (e.code === 'PageUp') { c64.restore(); e.preventDefault(); return; }
  if (joyPort && JOY_KEYS[e.code] !== undefined) {
    keyJoy |= JOY_KEYS[e.code]; applyJoy(); e.preventDefault(); return;
  }
  if (keyboard.keyDown(e)) e.preventDefault();
});
screenWrap.addEventListener('keyup', (e) => {
  if (joyPort && JOY_KEYS[e.code] !== undefined) {
    keyJoy &= ~JOY_KEYS[e.code]; applyJoy(); e.preventDefault(); return;
  }
  if (keyboard.keyUp(e)) e.preventDefault();
});
screenWrap.addEventListener('blur', () => { keyboard.releaseAll(); keyJoy = 0; applyJoy(); screenWrap.dataset.focus = '0'; });
screenWrap.addEventListener('focus', () => { screenWrap.dataset.focus = '1'; });
screenWrap.addEventListener('pointerdown', () => { startAudio(); setTimeout(updateAudioStatus, 100); screenWrap.focus(); });
screenWrap.addEventListener('paste', (e) => {
  const text = e.clipboardData?.getData('text');
  if (text) { c64.typeText(text); toast('Testo incollato nel C64'); e.preventDefault(); }
});

function pollGamepad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let v = 0;
  for (const p of pads) {
    if (!p) continue;
    const ax = p.axes[0] ?? 0, ay = p.axes[1] ?? 0;
    const btn = (i: number) => !!p.buttons[i]?.pressed;
    if (ay < -0.5 || btn(12)) v |= 1;
    if (ay > 0.5 || btn(13)) v |= 2;
    if (ax < -0.5 || btn(14)) v |= 4;
    if (ax > 0.5 || btn(15)) v |= 8;
    if (btn(0) || btn(1) || btn(2) || btn(3)) v |= 16;
  }
  if (v !== padJoy) { padJoy = v; if (!joyPort && v) { setJoyPort(2); } applyJoy(); }
}

function setJoyPort(p: number) {
  joyPort = p;
  store.set('c64.joyport', String(p));
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-joy]')) b.setAttribute('aria-pressed', String(Number(b.dataset.joy) === p));
  keyJoy = 0; applyJoy();
}
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-joy]')) b.addEventListener('click', () => setJoyPort(Number(b.dataset.joy)));

// ---------- on-screen joystick and keys ----------
function setupTouchControls() {
  const pad = $('touchpad');
  const toggle = $('touch-toggle');
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const saved = store.get('c64.touch');
  const show = (on: boolean) => {
    pad.hidden = !on;
    toggle.setAttribute('aria-pressed', String(on));
    store.set('c64.touch', on ? '1' : '0');
  };
  show(saved === null ? coarse : saved === '1');
  if (coarse) document.querySelector('#screen-wrap .hint')!.textContent = "Tocca lo schermo per attivare l'audio";
  toggle.addEventListener('click', () => show(pad.hidden));

  const buzz = () => { try { navigator.vibrate?.(8); } catch { /* not supported */ } };
  const ensurePort = () => { if (!joyPort) setJoyPort(2); };

  // d-pad: direction from the touch position relative to the centre, 8 directions
  const dpad = $('dpad'), knob = $('knob');
  let dpadPointer = -1;
  const setDir = (bits: number, kx = 0, ky = 0) => {
    const changed = (touchJoy & 15) !== bits;
    touchJoy = (touchJoy & 16) | bits;
    knob.style.transform = `translate(${kx}px, ${ky}px)`;
    dpad.dataset.dir = String(bits);
    if (changed && bits) buzz();
    applyJoy();
  };
  const track = (e: PointerEvent) => {
    const r = dpad.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const dx = e.clientX - cx, dy = e.clientY - cy;
    const radius = r.width / 2;
    const dist = Math.hypot(dx, dy);
    const k = Math.min(dist, radius * 0.45) / (dist || 1);
    if (dist < radius * 0.18) { setDir(0, dx * k, dy * k); return; }
    const sector = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)); // 0 = right, 2 = down, ±4 = left, -2 = up
    const DIRS: Record<string, number> = { '0': 8, '1': 8 | 2, '2': 2, '3': 2 | 4, '4': 4, '-4': 4, '-3': 4 | 1, '-2': 1, '-1': 1 | 8 };
    setDir(DIRS[String(sector)] ?? 0, dx * k, dy * k);
  };
  dpad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    startAudio(); ensurePort();
    dpadPointer = e.pointerId;
    try { dpad.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    track(e);
  });
  dpad.addEventListener('pointermove', (e) => { if (e.pointerId === dpadPointer) track(e); });
  const endDpad = (e: PointerEvent) => { if (e.pointerId !== dpadPointer) return; dpadPointer = -1; setDir(0); };
  dpad.addEventListener('pointerup', endDpad);
  dpad.addEventListener('pointercancel', endDpad);

  // fire button
  const fire = $('fire');
  const fireOn = (on: boolean) => {
    touchJoy = on ? touchJoy | 16 : touchJoy & ~16;
    fire.dataset.down = on ? '1' : '0';
    applyJoy();
  };
  fire.addEventListener('pointerdown', (e) => {
    e.preventDefault(); startAudio(); ensurePort(); buzz();
    try { fire.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    fireOn(true);
  });
  fire.addEventListener('pointerup', () => fireOn(false));
  fire.addEventListener('pointercancel', () => fireOn(false));

  // C64 keys games commonly ask for
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-vkey]')) {
    const id = b.dataset.vkey!;
    let held = false;
    const up = () => { if (!held) return; held = false; b.dataset.down = '0'; keyboard.virtualUp(id); };
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault(); startAudio(); buzz();
      try { b.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      held = true; b.dataset.down = '1';
      keyboard.virtualDown(id, b.dataset.vkey!, (b.dataset.shift as any) ?? 'off');
    });
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
  }
}

// ---------- files ----------
let disk: (DiskImage & { files: D64File[] }) | null = null;

function onDiskLoad(name: string, ok: boolean) {
  toast(ok ? `Caricato da disco: ${name}` : `File non trovato sul disco: ${name}`);
}
c64.onDiskLoad = onDiskLoad;

async function handleFiles(files: FileList | File[]) {
  const list = Array.from(files);
  const roms = list.filter((f) => /\.(bin|rom)$/i.test(f.name) || f.size === 4096 || (f.size === 8192 && !/\.(prg|d64|t64)$/i.test(f.name)));
  if (roms.length) { await loadRoms(roms); }
  const progs = list.filter((f) => !roms.includes(f));
  if (!progs.length) return;
  const f = progs[0];
  const data = new Uint8Array(await f.arrayBuffer());
  const name = f.name.toLowerCase();
  try {
    if (name.endsWith('.d64') || data.length === 174848 || data.length === 175531 || data.length === 196608) {
      disk = parseD64(data);
      c64.mountDisk(disk);
      showDirectory(f.name);
      const first = disk.files.find((x) => x.data);
      toast(`Disco inserito: ${disk.files.length} file. Clicca un file per avviarlo.`);
      if (first && disk.files.filter((x) => x.data).length === 1) runFile(first);
    } else if (name.endsWith('.t64')) {
      disk = parseT64(data);
      c64.mountDisk(disk);
      showDirectory(f.name);
      const first = disk.files[0];
      if (first) runFile(first);
    } else {
      if (data.length < 3) throw new Error('file vuoto');
      startAudio();
      c64.loadAndRun(data);
      const addr = data[0] | (data[1] << 8);
      toast(`Avviato ${f.name} (indirizzo $${addr.toString(16).toUpperCase().padStart(4, '0')})`);
    }
  } catch (err) {
    toast(`Impossibile leggere ${f.name}: ${(err as Error).message}`);
  }
  screenWrap.focus();
}

function runFile(file: D64File) {
  if (!file.data) return;
  startAudio();
  c64.loadAndRun(file.data);
  if (disk) c64.mountDisk(disk);
  toast(`Avviato "${file.name}"`);
  screenWrap.focus();
}

function showDirectory(fileName: string) {
  const box = $('directory');
  box.hidden = !disk;
  if (!disk) return;
  $('dir-title').textContent = `${fileName} · “${disk.title.trim()}”`;
  const ul = $('dir-list');
  ul.replaceChildren();
  for (const f of disk.files) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.disabled = !f.data;
    btn.innerHTML = `<span class="blk">${f.blocks}</span><span class="nm"></span><span class="ty">${f.type}</span>`;
    (btn.querySelector('.nm') as HTMLElement).textContent = `"${f.name}"`;
    btn.addEventListener('click', () => runFile(f));
    li.append(btn);
    ul.append(li);
  }
}
$('eject').addEventListener('click', () => {
  disk = null; c64.mountDisk(null); showDirectory(''); toast('Disco espulso');
});

const fileInput = $<HTMLInputElement>('file');
fileInput.addEventListener('change', () => { if (fileInput.files) handleFiles(fileInput.files); fileInput.value = ''; });
$('pick').addEventListener('click', () => fileInput.click());
for (const el of [document.body]) {
  el.addEventListener('dragover', (e) => { e.preventDefault(); document.body.dataset.drag = '1'; });
  el.addEventListener('dragleave', (e) => { if (e.target === document.body || !(e as DragEvent).relatedTarget) document.body.dataset.drag = '0'; });
  el.addEventListener('drop', (e) => {
    e.preventDefault(); document.body.dataset.drag = '0';
    const files = (e as DragEvent).dataTransfer?.files;
    if (files?.length) handleFiles(files);
  });
}

// ---------- ROM management ----------
async function loadRoms(files: File[]) {
  const found: string[] = [];
  for (const f of files) {
    const d = new Uint8Array(await f.arrayBuffer());
    const kind = identifyRom(d);
    if (!kind) { toast(`${f.name} non sembra una ROM C64 (servono file da 8 KB o 4 KB)`); continue; }
    userRoms[kind] = bytesToB64(d);
    found.push(kind.toUpperCase());
  }
  if (!found.length) return;
  store.set('c64.roms', JSON.stringify(userRoms));
  if (userRoms.basic && userRoms.kernal) {
    rebuildMachine();
    toast(`ROM originali caricate (${found.join(', ')}). Il C64 è stato riavviato.`);
  } else {
    updateRomStatus();
    const missing = ['basic', 'kernal'].filter((k) => !(userRoms as any)[k]).map((k) => k.toUpperCase());
    toast(`Caricata ${found.join(', ')}. Manca ancora: ${missing.join(' e ')}.`);
  }
}
const romInput = $<HTMLInputElement>('romfile');
romInput.addEventListener('change', () => { if (romInput.files) loadRoms(Array.from(romInput.files)); romInput.value = ''; });
$('pick-rom').addEventListener('click', () => romInput.click());
$('reset-rom').addEventListener('click', () => {
  userRoms = {}; store.del('c64.roms'); rebuildMachine(); toast('Tornato alle ROM libere');
});
function updateRomStatus() {
  const s = $('rom-status');
  const have = (k: keyof UserRoms) => (userRoms[k] ? 'ok' : 'no');
  s.dataset.original = romInfo.original ? '1' : '0';
  $('rom-name').textContent = romInfo.original ? 'ROM originali' : 'Open ROMs (libere)';
  $('rom-note').textContent = romInfo.original
    ? 'BASIC V2 e KERNAL completi.'
    : 'Il BASIC libero non ha numeri decimali, FOR, POKE e PEEK. Carica le tue ROM per il BASIC completo.';
  for (const k of ['basic', 'kernal', 'chargen'] as const) $('rom-' + k).dataset.state = have(k);
  $('reset-rom').hidden = !(userRoms.basic || userRoms.kernal || userRoms.chargen);
  $('rom-banner').hidden = romInfo.original;
}

// ---------- controls ----------
$('reset').addEventListener('click', () => { c64.reset(); if (disk) c64.mountDisk(disk); toast('Reset'); screenWrap.focus(); });
$('restore').addEventListener('click', () => { c64.restore(); screenWrap.focus(); });
$('pause').addEventListener('click', () => {
  paused = !paused;
  $('pause').setAttribute('aria-pressed', String(paused));
  $('pause').textContent = paused ? 'Riprendi' : 'Pausa';
  screenWrap.dataset.paused = paused ? '1' : '0';
});
$('turbo').addEventListener('click', () => {
  turbo = !turbo;
  $('turbo').setAttribute('aria-pressed', String(turbo));
  screenWrap.focus();
});
// ---------- full screen: emulator on top, C64 keyboard or joystick below ----------
const monitor = $('monitor');
function setFsMode(mode: string) {
  monitor.dataset.fsmode = mode;
  store.set('c64.fsmode', mode);
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-fsmode]')) b.setAttribute('aria-pressed', String(b.dataset.fsmode === mode));
}
async function enterFullscreen() {
  monitor.classList.add('fs');
  document.body.classList.add('fs-open');
  $('fullscreen').setAttribute('aria-pressed', 'true');
  startAudio();
  try { await monitor.requestFullscreen?.({ navigationUI: 'hide' } as FullscreenOptions); } catch { /* iPhone Safari: CSS-only full page */ }
}
function leaveFullscreen() {
  monitor.classList.remove('fs');
  document.body.classList.remove('fs-open');
  $('fullscreen').setAttribute('aria-pressed', 'false');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && monitor.classList.contains('fs')) leaveFullscreen();
});
$('fullscreen').addEventListener('click', () => {
  if (monitor.classList.contains('fs')) leaveFullscreen(); else enterFullscreen();
});
$('fs-exit').addEventListener('click', leaveFullscreen);
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-fsmode]')) b.addEventListener('click', () => setFsMode(b.dataset.fsmode!));
setFsMode(store.get('c64.fsmode') === 'joy' ? 'joy' : 'kbd');
buildKeyboard($('vkbd'), {
  down: (id, keys) => keyboard.virtualDownKeys(id, keys),
  up: (id) => keyboard.virtualUp(id),
  restore: () => c64.restore(),
  touched: () => startAudio(),
});
const vol = $<HTMLInputElement>('volume');
vol.value = String(Math.round(volume * 100));
vol.addEventListener('input', () => {
  volume = Number(vol.value) / 100;
  store.set('c64.volume', String(volume));
  if (audio) audio.gain.gain.value = volume;
  startAudio(); updateAudioStatus();
});

$('type-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const ta = $<HTMLTextAreaElement>('type-text');
  if (!ta.value) return;
  c64.typeText(ta.value.endsWith('\n') ? ta.value : ta.value + '\n');
  ta.value = '';
  startAudio();
  toast('Sto digitando il testo nel C64…');
});

$('demo').addEventListener('click', () => {
  startAudio();
  if (!romInfo.original) {
    toast('La demo usa FOR, POKE e numeri decimali: carica prima le ROM originali.');
    return;
  }
  c64.reset();
  if (disk) c64.mountDisk(disk);
  for (let i = 0; i < 160; i++) c64.runFrame();
  c64.typeText(DEMO);
  screenWrap.focus();
  toast('Sto digitando la demo BASIC…');
});



// ---------- status ----------
let toastTimer = 0;
function toast(msg: string) {
  const t = $('toast');
  t.textContent = msg;
  t.dataset.show = '1';
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { t.dataset.show = '0'; }, 3800);
}
let fpsFrames = 0, fpsT = performance.now(), lastFrameCount = 0;
function updateLeds() {
  const now = performance.now();
  if (now - fpsT > 1000) {
    const frames = framesRun - lastFrameCount;
    lastFrameCount = framesRun;
    const pct = Math.round((frames / ((now - fpsT) / 1000)) / FRAME_HZ * 100);
    $('speed').textContent = `${Math.max(0, pct)}%`;
    fpsT = now; fpsFrames = 0;
    updateAudioStatus();
  }
  fpsFrames++;
  screenWrap.dataset.typing = c64.isTyping ? '1' : '0';
}

// palette strip in the header comes straight from the VIC-II palette
const strip = $('palette');
for (let i = 0; i < 16; i++) {
  const p = PALETTE[i];
  const sw = document.createElement('i');
  sw.style.background = `rgb(${p & 255},${(p >> 8) & 255},${(p >> 16) & 255})`;
  sw.title = `Colore ${i}`;
  strip.append(sw);
}

setJoyPort(joyPort);
setupTouchControls();
updateRomStatus();
updateAudioStatus();
for (let i = 0; i < 120; i++) c64.runFrame(); // boot straight to READY.
draw();
requestAnimationFrame(loop);
