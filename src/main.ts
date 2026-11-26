import { C64, Roms } from './c64';
import type { SidModel } from './sid';
import { SCREEN_W, SCREEN_H, PALETTE } from './vic';
import { KeyboardMapper, JOY_KEYS } from './keyboard';
import { parseD64, parseT64, D64File, DiskImage } from './media';
import { OPEN_BASIC, OPEN_KERNAL, OPEN_CHARGEN } from './roms';
import { DEMO } from './demo';
import { buildKeyboard } from './vkbd';
import { Cartridge } from './cartridge';
import { blankDisk, isDiskImageSize, geometryFor, DiskKind } from './geometry';
import { Tape, blankTap } from './tape';
import { isG64, parseG64, gcrDiskToD64 } from './gcr';
import { listSnapshots, putSnapshot, deleteSnapshot, fingerprint, bytesToBase64, base64ToBytes, capture, restore, StoredSnapshot } from './snapshot';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const b64ToBytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const bytesToB64 = (b: Uint8Array) => { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); };
const store = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  del(k: string) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
};

// ---------- ROMs ----------
interface UserRoms { basic?: string; kernal?: string; chargen?: string; dos1541?: string; }
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
  if (d.length === 16384) {
    const reset = d[0x3ffc] | (d[0x3ffd] << 8);
    return reset >= 0xc000 ? 'dos1541' : null;
  }
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
  if (videoNtsc) c64.setStandard(true);
  if (disk) c64.mountDisk(disk, diskImage);
  wireMachine();
  if (cartridge) c64.insertCartridge(cartridge);
  if (tape) c64.insertTape(tape);
  c64.enableDrive9(drive9On);
  if (disk9Image) c64.mountDisk(listDisk(disk9Image), disk9Image, false, 9);
  c64.setReu(reuSize);
  c64.sid.model = sidModel;
  applyPortDevices();
  applyDriveMode();
  updateRomStatus();
}

// ---------- drive 8: fast virtual drive or fully emulated 1541 ----------
let trueDrive = store.get('c64.truedrive') !== '0';
let autoTurbo = store.get('c64.autoturbo') !== '0';
// the tape has its own setting: off = the Datasette runs at its real speed (counter included)
let tapeTurbo = (store.get('c64.tapeturbo') ?? store.get('c64.autoturbo')) !== '0';
function applyDriveMode() {
  const on = trueDrive && !!userRoms.dos1541;
  if (on === !!c64.drive) return;
  c64.attachDrive(on ? b64ToBytes(userRoms.dos1541!) : null);
  c64.reset();
  if (disk) c64.mountDisk(disk, diskImage);
  if (disk9Image) c64.mountDisk(listDisk(disk9Image), disk9Image, false, 9);
}
function setTrueDrive(on: boolean) {
  trueDrive = on;
  store.set('c64.truedrive', on ? '1' : '0');
  applyDriveMode();
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
      if (paused || warping) { out.fill(0); return; }
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
let paused = false, turbo = false, warping = false;
let lastTime = performance.now(), acc = 0;

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
    // with the emulated 1541, run flat out while the drive motor spins (loading at real speed is slow)
    warping = turbo || (autoTurbo && !!c64.drive && c64.drive.motor) || (tapeTurbo && !!c64.tape && c64.tape.running);
    screenWrap.dataset.warp = warping && !turbo ? '1' : '0';
    if (warping) {
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
      const frameMs = 1000 / c64.frameHz;
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
screenWrap.addEventListener('pointerdown', () => {
  startAudio(); setTimeout(updateAudioStatus, 100); screenWrap.focus();
  // a mouse or paddles are plugged in: capture the pointer so it can move freely
  if (usesMouse() && document.pointerLockElement !== screenWrap) {
    try { (screenWrap.requestPointerLock as () => Promise<void> | void)()?.catch?.(() => {}); } catch { /* not available */ }
  }
});

// ---------- mouse 1351 and paddles ----------
type PortDev = 'joystick' | 'mouse' | 'paddle';
const usesMouse = () => c64.portDevice[1] !== 'joystick' || c64.portDevice[2] !== 'joystick';
const savedDev = (n: 1 | 2): PortDev => { const v = store.get('c64.port' + n); return v === 'mouse' || v === 'paddle' ? v : 'joystick'; };
let portDev: [PortDev, PortDev] = [savedDev(1), savedDev(2)];
function applyPortDevices() {
  c64.portDevice[1] = portDev[0];
  c64.portDevice[2] = portDev[1];
  for (const n of [1, 2] as const) {
    for (const b of document.querySelectorAll<HTMLButtonElement>(`[data-dev${n}]`)) b.setAttribute('aria-pressed', String(b.dataset[`dev${n}`] === portDev[n - 1]));
  }
  $('mouse-note').hidden = !usesMouse();
}
for (const n of [1, 2] as const) {
  for (const b of document.querySelectorAll<HTMLButtonElement>(`[data-dev${n}]`)) b.addEventListener('click', () => {
    portDev[n - 1] = b.dataset[`dev${n}`] as PortDev;
    store.set('c64.port' + n, portDev[n - 1]);
    applyPortDevices();
    const name = { joystick: 'joystick', mouse: 'mouse 1351', paddle: 'paddle' }[portDev[n - 1]];
    toast(`Porta ${n}: ${name}${portDev[n - 1] === 'joystick' ? '' : '. Clicca sullo schermo per catturare il mouse.'}`);
  });
}
const MOUSE_SCALE = 0.5;   // 1351 counts per screen pixel of mouse movement
let mouseFrac = [0, 0];
function onMouseMove(e: MouseEvent) {
  if (!usesMouse() || document.pointerLockElement !== screenWrap) return;
  const fx = mouseFrac[0] + e.movementX * MOUSE_SCALE, fy = mouseFrac[1] + e.movementY * MOUSE_SCALE;
  const dx = Math.trunc(fx), dy = Math.trunc(fy);
  mouseFrac = [fx - dx, fy - dy];
  c64.mouseX += dx; c64.mouseY += dy;
  // paddles: turning right lowers the value, like the real potentiometer
  const clamp = (v: number) => Math.max(0, Math.min(255, v));
  c64.paddle[0] = clamp(c64.paddle[0] - dx);
  c64.paddle[1] = clamp(c64.paddle[1] - dy);
}
document.addEventListener('mousemove', onMouseMove);
screenWrap.addEventListener('mousedown', (e) => {
  if (!usesMouse() || document.pointerLockElement !== screenWrap) return;
  const bit = e.button === 2 ? 2 : e.button === 0 ? 1 : 0;
  c64.mouseButtons |= bit; c64.paddleButtons |= bit;
  e.preventDefault();
});
document.addEventListener('mouseup', (e) => {
  const bit = e.button === 2 ? 2 : e.button === 0 ? 1 : 0;
  c64.mouseButtons &= ~bit; c64.paddleButtons &= ~bit;
});
screenWrap.addEventListener('contextmenu', (e) => { if (usesMouse()) e.preventDefault(); });
document.addEventListener('pointerlockchange', () => {
  const on = document.pointerLockElement === screenWrap;
  screenWrap.dataset.mouse = on ? '1' : '0';
  if (!on) { c64.mouseButtons = 0; c64.paddleButtons = 0; }
});
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
let diskImage: Uint8Array | null = null;

// ---------- drive 8: activity LED and quick commands ----------
let driveBusyUntil = 0;
let autoRunNext = false;
function flashDrive(ms = 900) { driveBusyUntil = performance.now() + ms; }
function updateDrive() {
  const busy = performance.now() < driveBusyUntil || !!c64.drive?.led;
  for (const el of document.querySelectorAll<HTMLElement>('.drive')) {
    el.dataset.disk = disk ? '1' : '0';
    el.dataset.busy = busy ? '1' : '0';
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>('.js-dir, .js-run')) b.disabled = !disk;
}

function onDiskLoad(name: string, ok: boolean, start?: number) {
  flashDrive();
  if (ok && autoRunNext && start !== undefined) {
    c64.typeText(start === 0x0801 ? 'RUN\n' : `SYS${start}\n`);
  }
  autoRunNext = false;
  toast(ok ? `Caricato da disco: ${name}` : `File non trovato sul disco: ${name}`);
}

let fastloaderWarned = false;
function wireMachine() {
  c64.onDiskLoad = onDiskLoad;
  c64.onDiskChanged = onDiskChanged;
  c64.onDiskSave = onDiskSave;
  c64.onDriveActivity = (dev) => (dev === 9 ? flashDrive9() : flashDrive());
  c64.onFastloader = () => {
    if (fastloaderWarned) return;
    fastloaderWarned = true;
    toast('Questo programma usa un caricatore veloce (fastloader) che richiede un drive 1541 emulato in modo completo: per ora non è supportato.');
  };
}

/** Show the disk directory the C64 way: LOAD"$",8 then LIST. */
function showDiskDirectory() {
  if (!disk) { toast('Nessun disco inserito'); return; }
  startAudio();
  flashDrive(400);
  c64.typeText('LOAD"$",8\nLIST\n');
  toast('Directory: LOAD"$",8 e LIST');
  screenWrap.focus();
}

/** Load and start the first program on the disk: LOAD"*",8,1 then RUN (or SYS for machine code). */
function runFirstProgram() {
  if (!disk) { toast('Nessun disco inserito'); return; }
  const first = disk.files.find((f) => f.data && f.type === 'PRG');
  if (!first) { toast('Sul disco non ci sono programmi'); return; }
  startAudio();
  c64.reset();
  for (let i = 0; i < 160; i++) c64.runFrame(); // boot to READY.
  c64.sid.readPos = c64.sid.writePos;
  c64.mountDisk(disk, diskImage);
  flashDrive(400);
  if (c64.drive) {
    // real drive: no LOAD hook, so queue RUN/SYS from the address stored in the file
    const start = first.data!.length >= 2 ? first.data![0] | (first.data![1] << 8) : 0x0801;
    c64.typeText('LOAD"*",8,1\n' + (start === 0x0801 ? 'RUN\n' : `SYS${start}\n`));
  } else {
    autoRunNext = true;
    c64.typeText('LOAD"*",8,1\n');
  }
  toast(`Carico il primo programma: "${first.name}"`);
  screenWrap.focus();
}
for (const b of document.querySelectorAll<HTMLButtonElement>('.js-dir')) b.addEventListener('click', showDiskDirectory);
for (const b of document.querySelectorAll<HTMLButtonElement>('.js-run')) b.addEventListener('click', runFirstProgram);
wireMachine();
applyDriveMode();

// ---------- cassette (Datasette) ----------
let tape: Tape | null = null;
function insertTape(t: Tape | null, autostart = false) {
  tape = t;
  c64.insertTape(t);
  if (t) {
    t.onEnd = () => toast('Fine del nastro');
    t.onChanged = () => saveTape(t);
  }
  $('tape').hidden = !t;
  if (t) $('tape-name').textContent = t.name;
  if (t && autostart) startTape();
  else if (t) toast(`Nastro inserito: ${t.name}`);
}
/** Reset, type LOAD (+RUN) and press PLAY, as you would on a real C64. */
function startTape() {
  if (!tape) return;
  startAudio();
  c64.reset();
  if (disk) c64.mountDisk(disk, diskImage);
  for (let i = 0; i < 160; i++) c64.runFrame(); // boot to READY.
  c64.sid.readPos = c64.sid.writePos;
  tape.rewind();
  tape.playing = true;
  // the free Open ROMs default LOAD to device 8, so name the tape explicitly there
  c64.typeText((romInfo.original ? 'LOAD\n' : 'LOAD"",1\n') + 'RUN\n');
  toast(romInfo.original
    ? (tapeTurbo
      ? `Caricamento dal nastro: ${tape.name}. Il turbo lo accelera; per la velocità reale togli “Turbo” nel pannello Registratore.`
      : `Caricamento dal nastro: ${tape.name}, a velocità reale (può richiedere diversi minuti).`)
    : `Caricamento dal nastro: ${tape.name}. Con le ROM libere, a caricamento finito scrivi RUN.`);
  screenWrap.focus();
}
function updateTape() {
  if (!tape) return;
  $<HTMLElement>('tape-bar').style.width = `${(tape.progress * 100).toFixed(1)}%`;
  $('tape-pct').textContent = `${Math.round(tape.progress * 100)}%`;
  const state = tape.recording
    ? (tape.motor ? 'Registrazione in corso · motore acceso' : 'RECORD e PLAY premuti · motore fermo')
    : tape.atEnd && tape.length ? 'Fine del nastro' : tape.running ? 'In riproduzione · motore acceso' : tape.playing ? 'PLAY premuto · motore fermo' : tape.length ? 'Fermo' : 'Nastro vuoto · premi Registra e poi SAVE';
  $('tape-state').textContent = state;
  $('tape').dataset.running = tape.running ? '1' : '0';
  $('tape-counter').textContent = String(tape.counter).padStart(3, '0');
  $('tape-play').setAttribute('aria-pressed', String(tape.playing && !tape.recording));
  $('tape-rec').setAttribute('aria-pressed', String(tape.recording));
  $('tape').dataset.rec = tape.recording ? '1' : '0';
}
const tapeKey = (name: string) => 'c64.tape:' + name.toLowerCase();
function saveTape(t: Tape) {
  store.set(tapeKey(t.name), bytesToB64(t.toTap()));
  if (store.get(tapeKey(t.name)) === null) toast('Spazio del browser esaurito: scarica il nastro con “Scarica .tap” per non perderlo');
  else toast(`Registrazione aggiunta al nastro ${t.name} (salvato in questo browser)`);
  renderSavedDisks();
}
$('tape-rec').addEventListener('click', () => {
  if (!tape) return;
  if (tape.recording) tape.stop(); else { tape.startRecording(); startAudio(); }
  screenWrap.focus();
});
$('tape-stop').addEventListener('click', () => { tape?.stop(); screenWrap.focus(); });
$('tape-counter-reset').addEventListener('click', () => { tape?.resetCounter(); });
$('tape-download').addEventListener('click', () => {
  if (!tape) return;
  const name = /\.tap$/i.test(tape.name) ? tape.name : tape.name.replace(/\.[^.]*$/, '') + '.tap';
  try {
    const url = URL.createObjectURL(new Blob([tape.toTap()], { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast(`Scaricamento di ${name} avviato (se non parte, apri l'emulatore dal sito GitHub Pages)`);
  } catch { toast('Il browser ha bloccato lo scaricamento'); }
});
$('new-tape').addEventListener('click', () => {
  let n = 1;
  while (store.get(tapeKey(`nastro${n}.tap`))) n++;
  const t = new Tape(blankTap(), `nastro${n}.tap`);
  insertTape(t);
  toast(romInfo.original
    ? `Nastro vuoto “nastro${n}.tap” inserito. Scrivi SAVE"NOME" e, quando compare PRESS RECORD & PLAY, premi ⏺ Registra.`
    : 'Nastro vuoto inserito. Attenzione: le ROM libere non sanno salvare su nastro, servono le ROM originali.');
  screenWrap.focus();
});
$('tape-play').addEventListener('click', () => {
  if (tape) { if (tape.recording) tape.stop(); tape.playing = !tape.playing; startAudio(); }
  screenWrap.focus();
});
$('tape-rewind').addEventListener('click', () => { if (tape) { tape.stop(); tape.rewind(); toast('Nastro riavvolto'); } });
$('tape-start').addEventListener('click', () => startTape());
$('tape-eject').addEventListener('click', () => { tape?.stop(); insertTape(null); toast('Nastro espulso'); });

// ---------- cartridge ----------
let cartridge: Cartridge | null = null;
function showCartridge() {
  cartridge = c64.cart;
  const box = $('cartridge');
  box.hidden = !cartridge;
  for (const b of document.querySelectorAll<HTMLButtonElement>('.js-freeze')) b.hidden = !cartridge?.isFreezer;
  if (!cartridge) return;
  $('cart-name').textContent = cartridge.name;
  $('cart-type').textContent = cartridge.typeName;
}
for (const b of document.querySelectorAll<HTMLButtonElement>('.js-freeze')) b.addEventListener('click', () => {
  if (!c64.cart?.isFreezer) return;
  c64.cart.freeze();
  toast(`Freeze: il programma è fermo, comanda ${c64.cart.name}`);
  screenWrap.focus();
});
$('cart-remove').addEventListener('click', () => {
  c64.insertCartridge(null);
  if (disk) c64.mountDisk(disk, diskImage);
  showCartridge();
  toast('Cartuccia rimossa: il C64 è stato riavviato');
  screenWrap.focus();
});

async function handleFiles(files: FileList | File[]) {
  const list = Array.from(files);
  const roms = list.filter((f) => /\.(bin|rom)$/i.test(f.name) || f.size === 4096 || ((f.size === 8192 || f.size === 16384) && !/\.(prg|d64|t64|crt|tap)$/i.test(f.name)));
  if (roms.length) { await loadRoms(roms); }
  const progs = list.filter((f) => !roms.includes(f));
  if (!progs.length) return;
  const f = progs[0];
  const data = new Uint8Array(await f.arrayBuffer());
  const name = f.name.toLowerCase();
  try {
    if (name.endsWith('.tap') || String.fromCharCode(...data.subarray(0, 12)) === 'C64-TAPE-RAW') {
      insertTape(new Tape(data, f.name), true);
    } else if (name.endsWith('.crt') || String.fromCharCode(...data.subarray(0, 13)) === 'C64 CARTRIDGE') {
      const cart = new Cartridge(data);
      startAudio();
      c64.insertCartridge(cart);
      if (disk) c64.mountDisk(disk, diskImage);
      showCartridge();
      toast(`Cartuccia inserita: ${cart.name}`);
    } else if (/\.(d64|d71|d81|g64)$/.test(name) || isDiskImageSize(data.length) || isG64(data)) {
      const saved = loadSavedDisk(f.name);
      originalImage = data.slice();
      const img = saved && (saved.length === data.length || isG64(saved)) ? saved : data;
      const note = isG64(img) ? prepareForG64() : '';
      insertD64(img, f.name, !!saved);
      if (note) setTimeout(() => toast(note.trim()), 50);
      const first = disk!.files.find((x) => x.data && x.type === 'PRG');
      toast(saved
        ? `Disco inserito con le modifiche salvate in questo browser (${disk!.files.length} file). Per ripartire dal file originale usa “Torna all'originale”.`
        : `Disco inserito: ${disk!.files.length} file. Clicca un file per avviarlo.`);
      if (!disk) return;
      if (first && disk.files.filter((x) => x.data && x.type === 'PRG').length === 1) runFile(first);
    } else if (name.endsWith('.t64')) {
      disk = parseT64(data);
      diskImage = null;
      diskName = f.name; diskModified = false; originalImage = null;
      c64.mountDisk(disk, diskImage);
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
  if (disk) c64.mountDisk(disk, diskImage);
  flashDrive();
  toast(`Avviato "${file.name}"`);
  screenWrap.focus();
}

function showDirectory(fileName: string) {
  const box = $('directory');
  box.hidden = !disk;
  if (!disk) return;
  $('dir-title').textContent = `${fileName} · “${disk.title.trim()}” · ${disk.freeBlocks} blocchi liberi`;
  $('dir-modified').hidden = !diskModified;
  $('download-disk').hidden = !diskImage;
  $('revert-disk').hidden = !(diskModified && originalImage);
  const ul = $('dir-list');
  ul.replaceChildren();
  for (const f of disk.files) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.disabled = !f.data || f.type !== 'PRG';
    btn.innerHTML = `<span class="blk">${f.blocks}</span><span class="nm"></span><span class="ty">${f.type}</span>`;
    (btn.querySelector('.nm') as HTMLElement).textContent = `"${f.name}"`;
    btn.addEventListener('click', () => runFile(f));
    li.append(btn);
    ul.append(li);
  }
}
$('eject').addEventListener('click', () => {
  c64.drive?.flushWrites();
  disk = null; diskImage = null; originalImage = null; diskModified = false;
  c64.mountDisk(null); showDirectory(''); toast('Disco espulso');
});

// ---------- writing to disk: keep changes, download, blank disks ----------
let diskName = '';
let diskModified = false;
let originalImage: Uint8Array | null = null;
const diskKey = (name: string) => 'c64.disk:' + name.toLowerCase();

function loadSavedDisk(name: string): Uint8Array | null {
  const b64 = store.get(diskKey(name));
  if (!b64) return null;
  try { return b64ToBytes(b64); } catch { return null; }
}

/** Directory listing of a disk image (a G64 is decoded from its GCR tracks). */
function listDisk(img: Uint8Array) { return parseD64(isG64(img) ? gcrDiskToD64(parseG64(img)) : img); }
const diskExt = (img: Uint8Array) => (isG64(img) ? 'g64' : geometryFor(img).kind);

/** G64 disks need the emulated 1541; returns a message if the mode had to change (or could not). */
function prepareForG64(): string {
  if (c64.drive) return '';
  if (userRoms.dos1541) { setTrueDrive(true); return ' Per il G64 è stato attivato il 1541 emulato.'; }
  return ' Senza la ROM del 1541 il G64 si legge in sola lettura con il drive virtuale (niente protezioni né fastloader).';
}

/** Insert a disk image in drive 8; returns true if it had to switch from the 1541 to the virtual drive. */
function insertD64(img: Uint8Array, name: string, modified: boolean): boolean {
  const g64 = isG64(img);
  const kind = g64 ? 'd64' : geometryFor(img).kind;
  const switched = kind !== 'd64' && !!c64.drive;
  if (switched) {
    // the emulated drive is a 1541: D71/D81 need the virtual drive
    setTrueDrive(false);
    toast(`Il 1541 emulato legge solo dischi D64: per questo ${kind.toUpperCase()} uso il drive virtuale. Puoi tornare al 1541 dal pannello Drive 8.`);
  }
  disk = listDisk(img);
  diskImage = img;
  diskName = name;
  diskModified = modified;
  c64.mountDisk(disk, diskImage);
  showDirectory(name);
  return switched;
}

/** Called whenever the emulated drive writes to the mounted disk. */
function onDiskChanged(device = 8) {
  if (device === 9) { onDisk9Changed(); return; }
  if (!diskImage) return;
  // a G64 stays as GCR: take the surface the 1541 wrote
  if (isG64(diskImage)) diskImage = c64.currentImage(8) ?? diskImage;
  disk = c64.disk ?? listDisk(diskImage);
  diskModified = true;
  showDirectory(diskName);
  flashDrive();
  store.set(diskKey(diskName), bytesToB64(diskImage));
  if (store.get(diskKey(diskName)) === null) toast('Spazio del browser esaurito: scarica il disco con “Scarica .d64” per non perdere le modifiche');
  else if (c64.drive) toast('Disco aggiornato dal 1541: le modifiche sono salvate in questo browser');
  renderSavedDisks();
}

function onDiskSave(name: string, code: number, device = 8) {
  if (code === 0) toast(`Salvato sul disco del drive ${device}: ${name}`);
  else if (code === 63) toast(`Sul disco esiste già “${name}”. Per sostituirlo: SAVE"@0:${name}",${device}`);
  else if (code === 26) toast('Questo disco è protetto da scrittura (i file .T64 non si possono modificare)');
  else toast('Disco pieno: il file non è stato salvato');
}

$('download-disk').addEventListener('click', () => {
  if (!diskImage) return;
  c64.drive?.flushWrites();
  if (isG64(diskImage)) diskImage = c64.currentImage(8) ?? diskImage;
  const ext = diskExt(diskImage);
  const name = /\.(d64|d71|d81|g64)$/i.test(diskName) ? diskName : diskName.replace(/\.[^.]*$/, '') + '.' + ext;
  try {
    const url = URL.createObjectURL(new Blob([diskImage], { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast(`Scaricamento di ${name} avviato (se non parte, apri l'emulatore dal sito GitHub Pages)`);
  } catch {
    toast('Il browser ha bloccato lo scaricamento');
  }
});

$('revert-disk').addEventListener('click', () => {
  if (!originalImage) return;
  store.del(diskKey(diskName));
  c64.drive?.flushWrites();
  c64.mountDisk(null);
  insertD64(originalImage.slice(), diskName, false);
  renderSavedDisks();
  toast('Ripristinato il disco originale: le modifiche salvate nel browser sono state cancellate');
});

$('new-disk').addEventListener('click', () => {
  c64.drive?.flushWrites();
  c64.mountDisk(null);
  const kind = ($<HTMLSelectElement>('new-disk-kind').value || 'd64') as DiskKind;
  let n = 1;
  while (store.get(diskKey(`disco${n}.${kind}`))) n++;
  originalImage = null;
  const switched = insertD64(blankDisk(kind, `DISCO ${n}`, String(n).padStart(2, '0')), `disco${n}.${kind}`, false);
  store.set(diskKey(diskName), bytesToB64(diskImage!));
  renderSavedDisks();
  toast(`Disco vuoto “disco${n}.${kind}” inserito nel drive 8. Salva con SAVE"NOME",8` +
    (switched ? `. Il 1541 emulato legge solo i D64, quindi ora è attivo il drive virtuale.` : ''));
  screenWrap.focus();
});

window.addEventListener('pagehide', () => { c64.drive?.flushWrites(); c64.drive9?.flushWrites(); });

// ---------- drive 9 ----------
let drive9On = store.get('c64.drive9') === '1';
let disk9Image: Uint8Array | null = null;
let disk9Name = '';
let drive9BusyUntil = 0;
function flashDrive9(ms = 900) { drive9BusyUntil = performance.now() + ms; }
function setDrive9(on: boolean) {
  drive9On = on;
  store.set('c64.drive9', on ? '1' : '0');
  if (!on) { c64.drive9?.flushWrites(); disk9Image = null; disk9Name = ''; }
  c64.enableDrive9(on);
  showDrive9();
  renderSavedDisks();
}
function insertDisk9(img: Uint8Array, name: string) {
  const kind = isG64(img) ? 'd64' : geometryFor(img).kind;
  if (kind !== 'd64' && c64.drive) {
    setTrueDrive(false);
    toast(`Il 1541 emulato legge solo dischi D64: per questo ${kind.toUpperCase()} uso i drive virtuali.`);
  }
  c64.drive9?.flushWrites();
  disk9Image = img; disk9Name = name;
  c64.mountDisk(listDisk(img), img, false, 9);
  showDrive9();
}
function onDisk9Changed() {
  if (!disk9Image) return;
  if (isG64(disk9Image)) disk9Image = c64.currentImage(9) ?? disk9Image;
  flashDrive9();
  store.set(diskKey(disk9Name), bytesToB64(disk9Image));
  showDrive9();
  renderSavedDisks();
}
function showDrive9() {
  $('drive9').hidden = !drive9On;
  $<HTMLInputElement>('drive9-on').checked = drive9On;
  const d = c64.disk9;
  $('drive9-disk').textContent = d ? `${disk9Name} · “${d.title.trim()}” · ${d.freeBlocks} blocchi liberi · ${d.files.length} file` : 'Nessun disco';
  for (const id of ['drive9-download', 'drive9-eject']) $(id).hidden = !d;
}
function updateDrive9() {
  if (!drive9On) return;
  const el = $('drive9').querySelector<HTMLElement>('.drive')!;
  el.dataset.disk = c64.disk9 ? '1' : '0';
  el.dataset.busy = performance.now() < drive9BusyUntil || !!c64.drive9?.led ? '1' : '0';
}
$<HTMLInputElement>('drive9-on').addEventListener('change', (e) => {
  setDrive9((e.target as HTMLInputElement).checked);
  toast(drive9On ? 'Secondo drive collegato come device 9' : 'Secondo drive scollegato');
});
const file9 = $<HTMLInputElement>('file9');
$('drive9-insert').addEventListener('click', () => file9.click());
file9.addEventListener('change', async () => {
  const f = file9.files?.[0]; file9.value = '';
  if (!f) return;
  const data = new Uint8Array(await f.arrayBuffer());
  if (!isDiskImageSize(data.length) && !isG64(data)) { toast(`${f.name} non è un'immagine D64, D71, D81 o G64`); return; }
  const saved = loadSavedDisk(f.name);
  if (isG64(data)) { const note = prepareForG64(); if (note) setTimeout(() => toast(note.trim()), 50); }
  insertDisk9(saved && (saved.length === data.length || isG64(saved)) ? saved : data, f.name);
  toast(`Disco “${f.name}” inserito nel drive 9`);
});
$('drive9-new').addEventListener('click', () => {
  const kind = ($<HTMLSelectElement>('new-disk-kind').value || 'd64') as DiskKind;
  let n = 1;
  while (store.get(diskKey(`disco${n}.${kind}`))) n++;
  insertDisk9(blankDisk(kind, `DISCO ${n}`, String(n).padStart(2, '0')), `disco${n}.${kind}`);
  store.set(diskKey(disk9Name), bytesToB64(disk9Image!));
  renderSavedDisks();
  toast(`Disco vuoto “disco${n}.${kind}” inserito nel drive 9. Salva con SAVE"NOME",9`);
});
$('drive9-eject').addEventListener('click', () => {
  c64.drive9?.flushWrites();
  disk9Image = null; disk9Name = '';
  c64.mountDisk(null, null, false, 9);
  showDrive9();
  toast('Disco espulso dal drive 9');
});
$('drive9-download').addEventListener('click', () => {
  if (!disk9Image) return;
  c64.drive9?.flushWrites();
  if (isG64(disk9Image)) disk9Image = c64.currentImage(9) ?? disk9Image;
  const name = /\.(d64|d71|d81|g64)$/i.test(disk9Name) ? disk9Name : disk9Name + '.' + diskExt(disk9Image);
  try {
    const url = URL.createObjectURL(new Blob([disk9Image], { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch { toast('Il browser ha bloccato lo scaricamento'); }
});
c64.enableDrive9(drive9On);
showDrive9();

/** Disks kept in this browser (blank disks and modified ones), to reinsert after a reload. */
function renderSavedDisks() {
  const items: { kind: 'disk' | 'tape'; name: string }[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith('c64.disk:')) items.push({ kind: 'disk', name: k.slice(9) });
      if (k?.startsWith('c64.tape:')) items.push({ kind: 'tape', name: k.slice(9) });
    }
  } catch { /* storage unavailable */ }
  items.sort((a, b) => a.name.localeCompare(b.name));
  const names = items;
  const box = $('saved-disks');
  box.hidden = !names.length;
  const ul = $('saved-list');
  ul.replaceChildren();
  for (const { kind, name: n } of names) {
    const li = document.createElement('li');
    const open = document.createElement('button');
    open.type = 'button'; open.className = 'saved-open'; open.textContent = n;
    open.title = kind === 'tape' ? 'Inserisci nel registratore' : 'Inserisci nel drive 8';
    open.addEventListener('click', () => {
      if (kind === 'tape') {
        const b64 = store.get(tapeKey(n));
        try { insertTape(new Tape(b64ToBytes(b64 ?? ''), n)); toast(`Nastro “${n}” inserito nel registratore`); }
        catch { toast('Questo nastro salvato non si può leggere'); }
        screenWrap.focus();
        return;
      }
      const img = loadSavedDisk(n);
      if (!img) { toast('Questo disco salvato non si può leggere'); return; }
      c64.drive?.flushWrites();
      c64.mountDisk(null);
      originalImage = null;
      insertD64(img, n, false);
      toast(`Disco “${n}” inserito nel drive 8`);
      screenWrap.focus();
    });
    if (kind === 'disk' && drive9On) {
      const to9 = document.createElement('button');
      to9.type = 'button'; to9.className = 'saved-del'; to9.textContent = '→ 9';
      to9.title = 'Inserisci nel drive 9';
      to9.setAttribute('aria-label', `Inserisci ${n} nel drive 9`);
      to9.addEventListener('click', () => {
        const img = loadSavedDisk(n);
        if (img) { insertDisk9(img, n); toast(`Disco “${n}” inserito nel drive 9`); }
      });
      li.append(open, to9);
    }
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'saved-del'; del.textContent = 'Elimina';
    del.setAttribute('aria-label', `Elimina ${n} da questo browser`);
    let armed = false;
    del.addEventListener('click', () => {
      if (!armed) { armed = true; del.textContent = 'Conferma'; setTimeout(() => { armed = false; del.textContent = 'Elimina'; }, 3000); return; }
      store.del(kind === 'tape' ? tapeKey(n) : diskKey(n));
      renderSavedDisks();
      toast(`“${n}” eliminato da questo browser`);
    });
    if (!li.contains(open)) li.append(open);
    li.append(del);
    ul.append(li);
  }
}
renderSavedDisks();

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
    if (!kind) { toast(`${f.name} non sembra una ROM C64 o 1541 (servono file da 8 KB, 4 KB o 16 KB)`); continue; }
    userRoms[kind] = bytesToB64(d);
    found.push(kind.toUpperCase());
  }
  if (!found.length) return;
  store.set('c64.roms', JSON.stringify(userRoms));
  if (found.length === 1 && found[0] === 'DOS1541') {
    setTrueDrive(true);
    toast('ROM del 1541 caricata: il drive 8 ora è un 1541 emulato. Il C64 è stato riavviato.');
    return;
  }
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
  for (const k of ['basic', 'kernal', 'chargen', 'dos1541'] as const) $('rom-' + k).dataset.state = have(k);
  const real = !!c64.drive;
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-drivemode]')) {
    b.setAttribute('aria-pressed', String((b.dataset.drivemode === 'real') === real));
    if (b.dataset.drivemode === 'real') b.disabled = !userRoms.dos1541;
  }
  $('drive-note').textContent = real
    ? '1541 emulato: il drive esegue il suo DOS e legge il disco come un drive vero. Funzionano anche i fastloader, ma il caricamento normale ha la velocità reale (circa 400 byte al secondo).'
    : userRoms.dos1541
      ? 'Drive virtuale: carica all\'istante, ma non supporta i fastloader.'
      : 'Drive virtuale: carica all\'istante, ma non supporta i fastloader. Per il 1541 emulato carica la ROM del drive (file da 16 KB, nella cartella DRIVES di VICE).';
  $('reset-rom').hidden = !(userRoms.basic || userRoms.kernal || userRoms.chargen);
  $('rom-banner').hidden = romInfo.original;
}

for (const b of document.querySelectorAll<HTMLButtonElement>('[data-drivemode]')) b.addEventListener('click', () => {
  setTrueDrive(b.dataset.drivemode === 'real');
  toast(c64.drive ? '1541 emulato attivo: il C64 è stato riavviato' : 'Drive virtuale attivo: il C64 è stato riavviato');
});
const autoTurboBox = $<HTMLInputElement>('autoturbo');
autoTurboBox.checked = autoTurbo;
autoTurboBox.addEventListener('change', () => { autoTurbo = autoTurboBox.checked; store.set('c64.autoturbo', autoTurbo ? '1' : '0'); });
const tapeTurboBox = $<HTMLInputElement>('tapeturbo');
tapeTurboBox.checked = tapeTurbo;
tapeTurboBox.addEventListener('change', () => {
  tapeTurbo = tapeTurboBox.checked;
  store.set('c64.tapeturbo', tapeTurbo ? '1' : '0');
  toast(tapeTurbo ? 'Nastro accelerato durante i caricamenti' : 'Nastro a velocità reale: come un Datasette vero (un gioco può richiedere diversi minuti)');
});

// ---------- expansions: REU ----------
let reuSize = Number(store.get('c64.reu') ?? '0');
function setReuSize(kb: number) {
  reuSize = kb;
  store.set('c64.reu', String(kb));
  c64.setReu(kb);
  c64.reset();
  if (disk) c64.mountDisk(disk, diskImage);
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-reu]')) b.setAttribute('aria-pressed', String(Number(b.dataset.reu) === kb));
}
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-reu]')) b.addEventListener('click', () => {
  setReuSize(Number(b.dataset.reu));
  toast(reuSize ? `REU da ${reuSize} KB collegata: il C64 è stato riavviato` : 'REU scollegata: il C64 è stato riavviato');
});
c64.setReu(reuSize);
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-reu]')) b.setAttribute('aria-pressed', String(Number(b.dataset.reu) === reuSize));

// ---------- audio and video ----------
let sidModel: SidModel = store.get('c64.sid') === '8580' ? '8580' : '6581';
function setSidModel(m: SidModel) {
  sidModel = m;
  c64.sid.model = m;
  store.set('c64.sid', m);
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-sid]')) b.setAttribute('aria-pressed', String(b.dataset.sid === m));
}
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-sid]')) b.addEventListener('click', () => {
  setSidModel(b.dataset.sid as SidModel);
  toast(sidModel === '6581'
    ? 'SID 6581 (C64 "biscottiera"): filtro più scuro, voci campionate udibili'
    : 'SID 8580 (C64C): filtro più lineare, forme d\'onda combinate più forti, voci campionate quasi mute');
});
setSidModel(sidModel);

// PAL / NTSC
let videoNtsc = store.get('c64.video') === 'ntsc';
function setVideo(ntsc: boolean) {
  videoNtsc = ntsc;
  store.set('c64.video', ntsc ? 'ntsc' : 'pal');
  if (c64.ntsc !== ntsc) {
    c64.setStandard(ntsc);
    if (disk) c64.mountDisk(disk, diskImage);
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-video]')) b.setAttribute('aria-pressed', String((b.dataset.video === 'ntsc') === ntsc));
  $('video-status').textContent = ntsc ? 'NTSC · 1 022 727 Hz' : 'PAL · 985 248 Hz';
}
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-video]')) b.addEventListener('click', () => {
  const ntsc = b.dataset.video === 'ntsc';
  if (ntsc === videoNtsc) return;
  setVideo(ntsc);
  toast(ntsc ? 'C64 americano (NTSC, 60 Hz): il C64 è stato riavviato' : 'C64 europeo (PAL, 50 Hz): il C64 è stato riavviato');
});
setVideo(videoNtsc);

// TV effect: the scanline period follows the size the C64 picture is actually shown at
let crtOn = store.get('c64.crt') === '1';
function layoutCrt() {
  const o = $('crt');
  const box = canvas.getBoundingClientRect(), wrap = screenWrap.getBoundingClientRect();
  // with object-fit: contain (desktop full screen) the picture is letterboxed inside the canvas box
  const scale = Math.min(box.width / (SCREEN_W * 360 / 384), box.height / SCREEN_H);
  const fitted = getComputedStyle(canvas).objectFit === 'contain';
  const w = fitted ? SCREEN_W * 360 / 384 * scale : box.width, h = fitted ? SCREEN_H * scale : box.height;
  o.style.left = `${box.left - wrap.left + (box.width - w) / 2}px`;
  o.style.top = `${box.top - wrap.top + (box.height - h) / 2}px`;
  o.style.width = `${w}px`; o.style.height = `${h}px`;
  o.style.setProperty('--line', `${h / SCREEN_H}px`);
}
function setCrt(on: boolean) {
  crtOn = on;
  store.set('c64.crt', on ? '1' : '0');
  screenWrap.classList.toggle('crt', on);
  $<HTMLInputElement>('crt-on').checked = on;
  if (on) layoutCrt();
}
$<HTMLInputElement>('crt-on').addEventListener('change', (e) => setCrt((e.target as HTMLInputElement).checked));
new ResizeObserver(() => { if (crtOn) layoutCrt(); }).observe(canvas);
window.addEventListener('resize', () => { if (crtOn) layoutCrt(); });
document.addEventListener('fullscreenchange', () => setTimeout(() => { if (crtOn) layoutCrt(); }, 50));
setCrt(crtOn);

// ---------- snapshots ----------
const SNAP_FORMAT = 'droid64-snapshot';
const romPrint = () => fingerprint(romInfo.roms.basic, romInfo.roms.kernal, romInfo.roms.chargen);

function screenThumb(): string {
  try {
    const t = document.createElement('canvas');
    t.width = 192; t.height = 136;
    const g = t.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    g.drawImage(canvas, 0, 0, 192, 136);
    return t.toDataURL('image/png');
  } catch { return ''; }
}

function snapshotTitle(): string {
  const parts = [cartridge?.name, disk ? diskName : '', tape?.name].filter(Boolean);
  return parts.length ? parts.join(' · ') : romInfo.original ? 'BASIC' : 'BASIC (ROM libere)';
}

/** Everything needed to bring the machine back: configuration, media and the chips' state. */
function buildSnapshot() {
  c64.drive?.flushWrites(); c64.drive9?.flushWrites();
  const img8 = disk && diskImage ? c64.currentImage(8) ?? diskImage : null;
  const img9 = c64.disk9 && disk9Image ? c64.currentImage(9) ?? disk9Image : null;
  return {
    format: SNAP_FORMAT, version: 1, app: (document.getElementById('version')?.textContent ?? '').trim(),
    created: Date.now(), title: snapshotTitle(), thumb: screenThumb(),
    roms: romPrint(), driveRom: c64.drive ? fingerprint(b64ToBytes(userRoms.dos1541!)) : null,
    config: { reu: reuSize, trueDrive: !!c64.drive, drive9: drive9On, ports: portDev, joyPort, sid: sidModel, ntsc: videoNtsc },
    media: {
      disk8: img8 ? { name: diskName, data: bytesToBase64(img8) } : null,
      disk9: img9 ? { name: disk9Name, data: bytesToBase64(img9) } : null,
      tape: tape ? { name: tape.name, data: bytesToBase64(tape.toTap()), state: capture(tape, new Set(['data'])) } : null,
      cart: c64.cart ? { data: bytesToBase64(c64.cart.source) } : null,
    },
    state: c64.saveState(),
  };
}
type Snapshot = ReturnType<typeof buildSnapshot>;

async function saveSnapshot() {
  try {
    const snap = buildSnapshot();
    const data = JSON.stringify(snap);
    await putSnapshot({ id: String(snap.created), created: snap.created, title: snap.title, thumb: snap.thumb, size: data.length, data });
    await renderSnapshots();
    toast(`Snapshot salvato: ${snap.title}`);
  } catch (e) {
    toast(`Impossibile salvare lo snapshot: ${(e as Error).message || 'spazio del browser non disponibile'}`);
  }
}

function applySnapshot(snap: Snapshot) {
  if (snap.format !== SNAP_FORMAT) throw new Error('non è uno snapshot di droid64');
  if (snap.roms !== romPrint()) {
    throw new Error('è stato fatto con ROM del C64 diverse da quelle caricate ora (ROM originali o libere): carica le stesse ROM e riprova');
  }
  if (snap.config.trueDrive && !userRoms.dos1541) throw new Error('usa il 1541 emulato: carica prima la ROM del 1541');
  if (snap.config.trueDrive && snap.driveRom && snap.driveRom !== fingerprint(b64ToBytes(userRoms.dos1541!))) {
    throw new Error('è stato fatto con una ROM del 1541 diversa');
  }
  // configuration (these may reset the machine: the state is loaded afterwards)
  if (reuSize !== snap.config.reu) setReuSize(snap.config.reu);
  if (!!c64.drive !== snap.config.trueDrive) setTrueDrive(snap.config.trueDrive);
  if (drive9On !== snap.config.drive9) setDrive9(snap.config.drive9);
  if (snap.config.sid) setSidModel(snap.config.sid as SidModel);
  if (!!snap.config.ntsc !== videoNtsc) setVideo(!!snap.config.ntsc);
  portDev = snap.config.ports as [PortDev, PortDev];
  applyPortDevices();
  setJoyPort(snap.config.joyPort);
  // media
  const m = snap.media;
  c64.insertCartridge(m.cart ? new Cartridge(base64ToBytes(m.cart.data)) : null);
  showCartridge();
  c64.mountDisk(null);
  if (m.disk8) { originalImage = null; insertD64(base64ToBytes(m.disk8.data), m.disk8.name, true); }
  else { disk = null; diskImage = null; showDirectory(''); }
  if (drive9On) {
    if (m.disk9) insertDisk9(base64ToBytes(m.disk9.data), m.disk9.name);
    else { disk9Image = null; disk9Name = ''; c64.mountDisk(null, null, false, 9); showDrive9(); }
  }
  if (m.tape) {
    const t = new Tape(base64ToBytes(m.tape.data), m.tape.name);
    restore(t, m.tape.state);
    insertTape(t);
  } else insertTape(null);
  // the chips
  c64.loadState(snap.state as any);
  keyboard.releaseAll();
  draw();
}

async function restoreSnapshot(s: StoredSnapshot) {
  try {
    applySnapshot(JSON.parse(s.data));
    toast(`Snapshot ripristinato: ${s.title}`);
    screenWrap.focus();
  } catch (e) {
    toast(`Impossibile ripristinare lo snapshot: ${(e as Error).message}`);
  }
}

function downloadText(name: string, text: string) {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch { toast('Il browser ha bloccato lo scaricamento'); }
}

async function renderSnapshots() {
  let list: StoredSnapshot[] = [];
  try { list = await listSnapshots(); } catch { /* IndexedDB unavailable */ }
  list.sort((a, b) => b.created - a.created);
  const ul = $('snap-list');
  ul.replaceChildren();
  $('snap-empty').hidden = list.length > 0;
  for (const s of list) {
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.alt = ''; img.width = 96; img.height = 68;
    if (s.thumb) img.src = s.thumb; else img.style.visibility = 'hidden';
    const info = document.createElement('div');
    info.className = 'snap-info';
    const title = document.createElement('strong'); title.textContent = s.title;
    const when = document.createElement('small');
    when.textContent = `${new Date(s.created).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · ${(s.size / 1024 / 1024).toFixed(1)} MB`;
    const row = document.createElement('div'); row.className = 'row';
    const mk = (label: string, fn: () => void, cls = '') => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; if (cls) b.className = cls; b.addEventListener('click', fn); row.append(b); return b; };
    mk('Ripristina', () => restoreSnapshot(s), 'primary');
    mk('Scarica', () => downloadText(`droid64-${s.title.replace(/[^\w.-]+/g, '_')}-${s.id}.c64snap`, s.data));
    const del = mk('Elimina', async () => {
      if (del.dataset.armed !== '1') { del.dataset.armed = '1'; del.textContent = 'Conferma'; setTimeout(() => { del.dataset.armed = '0'; del.textContent = 'Elimina'; }, 3000); return; }
      try { await deleteSnapshot(s.id); } catch { /* ignore */ }
      renderSnapshots();
    });
    info.append(title, when, row);
    li.append(img, info);
    ul.append(li);
  }
}

for (const b of document.querySelectorAll<HTMLButtonElement>('.js-snap')) b.addEventListener('click', () => { saveSnapshot(); screenWrap.focus(); });
const snapFile = $<HTMLInputElement>('snapfile');
$('snap-load').addEventListener('click', () => snapFile.click());
snapFile.addEventListener('change', async () => {
  const f = snapFile.files?.[0]; snapFile.value = '';
  if (!f) return;
  try {
    const text = await f.text();
    const snap = JSON.parse(text) as Snapshot;
    applySnapshot(snap);
    await putSnapshot({ id: String(snap.created), created: snap.created, title: snap.title, thumb: snap.thumb || screenThumb(), size: text.length, data: text }).catch(() => {});
    renderSnapshots();
    toast(`Snapshot ripristinato da file: ${snap.title}`);
    screenWrap.focus();
  } catch (e) {
    toast(`Impossibile aprire lo snapshot: ${(e as Error).message}`);
  }
});
renderSnapshots();

// ---------- installable app (PWA) ----------
// Only the GitHub Pages build links a manifest: the artifact preview cannot register a service worker.
const isPwaBuild = !!document.querySelector('link[rel="manifest"]');
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone === true;
let installPrompt: any = null;
function updateAppPanel() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const state = !isPwaBuild ? 'unavailable' : standalone() ? 'installed' : installPrompt ? 'installable' : ios ? 'ios' : 'browser';
  $('app').dataset.state = state;
  $('app-install').hidden = state !== 'installable';
  const notes: Record<string, string> = {
    unavailable: "L'app si installa dal sito: apri https://mokkus68.github.io/droid64/ nel browser.",
    installed: "droid64 è installato come app e funziona anche senza connessione.",
    installable: "Installa droid64 come app: si apre a tutto schermo dalla sua icona e funziona anche senza connessione.",
    ios: "Su iPhone e iPad: tocca il pulsante Condividi di Safari e poi “Aggiungi alla schermata Home”.",
    browser: "Il browser non offre l'installazione in questo momento. In Chrome e Edge usa il menu ⋮ → “Installa app”; su iPhone usa Safari → Condividi → “Aggiungi alla schermata Home”. La pagina funziona comunque anche senza connessione.",
  };
  $('app-note').textContent = notes[state];
}
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; updateAppPanel(); });
window.addEventListener('appinstalled', () => { installPrompt = null; updateAppPanel(); toast('droid64 installato come app'); });
$('app-install').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  try { await installPrompt.userChoice; } catch { /* dismissed */ }
  installPrompt = null;
  updateAppPanel();
});
if (isPwaBuild && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const offerUpdate = (w: ServiceWorker | null) => {
      if (!w) return;
      const show = () => { if (w.state === 'installed' && navigator.serviceWorker.controller) $('app-update').hidden = false; };
      w.addEventListener('statechange', show);
      show();
      $('app-update-btn').onclick = () => w.postMessage('update');
    };
    offerUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => offerUpdate(reg.installing));
  }).catch(() => { /* not available (file://, private mode…) */ });
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloading && !$('app-update').hidden) { reloading = true; location.reload(); } });
}
updateAppPanel();

// ---------- controls ----------
$('reset').addEventListener('click', () => { c64.reset(); if (disk) c64.mountDisk(disk, diskImage); toast('Reset'); screenWrap.focus(); });
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
  setTimeout(() => { if (crtOn) layoutCrt(); }, 100);
  monitor.classList.add('fs');
  document.body.classList.add('fs-open');
  $('fullscreen').setAttribute('aria-pressed', 'true');
  startAudio();
  try { await monitor.requestFullscreen?.({ navigationUI: 'hide' } as FullscreenOptions); } catch { /* iPhone Safari: CSS-only full page */ }
  if (desktopPointer.matches) { screenWrap.focus(); showMouse(); }
}
// on a computer, full screen shows only the picture; the exit button appears while the mouse moves
const desktopPointer = window.matchMedia('(hover: hover) and (pointer: fine)');
let mouseTimer = 0;
function showMouse() {
  monitor.dataset.mouse = '1';
  clearTimeout(mouseTimer);
  mouseTimer = window.setTimeout(() => { monitor.dataset.mouse = '0'; }, 2000);
}
monitor.addEventListener('mousemove', () => { if (monitor.classList.contains('fs')) showMouse(); });
for (const b of document.querySelectorAll<HTMLButtonElement>('.fs-exit-float')) b.addEventListener('click', (e) => { e.stopPropagation(); leaveFullscreen(); });
function leaveFullscreen() {
  setTimeout(() => { if (crtOn) layoutCrt(); }, 100);
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

// ---------- screenshot and audio recording ----------
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
function downloadBlob(name: string, blob: Blob) {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return true;
  } catch { toast('Il browser ha bloccato lo scaricamento'); return false; }
}
$('shot').addEventListener('click', () => {
  // pixels doubled, without smoothing: a sharp 768×544 image of the C64 screen
  const out = document.createElement('canvas');
  out.width = SCREEN_W * 2; out.height = SCREEN_H * 2;
  const g = out.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  g.drawImage(canvas, 0, 0, out.width, out.height);
  out.toBlob((b) => {
    if (b && downloadBlob(`droid64-${stamp()}.png`, b)) toast('Schermata salvata (PNG 768×544)');
  }, 'image/png');
  screenWrap.focus();
});
let recTimer = 0;
function stopRecording() {
  const pcm = c64.sid.stopRecording();
  clearInterval(recTimer);
  $('rec').setAttribute('aria-pressed', 'false');
  $('rec').textContent = '⏺ Audio';
  if (!pcm || !pcm.length) { toast('Registrazione vuota'); return; }
  const sr = c64.sid.sampleRate;
  // 16-bit mono WAV
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const str = (o: number, t: string) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i] * 2)) * 32767, true);
  const secs = pcm.length / sr;
  if (downloadBlob(`droid64-${stamp()}.wav`, new Blob([buf], { type: 'audio/wav' }))) {
    toast(`Registrazione salvata: ${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')} (WAV)`);
  }
}
$('rec').addEventListener('click', () => {
  if (c64.sid.recording) { stopRecording(); return; }
  c64.sid.startRecording(10 * 60);
  $('rec').setAttribute('aria-pressed', 'true');
  const t0 = performance.now();
  recTimer = window.setInterval(() => {
    const s = c64.sid.recordedSeconds;
    $('rec').textContent = `⏹ ${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    if (!c64.sid.recording) stopRecording(); // reached the 10 minute limit
    void t0;
  }, 250);
  toast('Registrazione del SID avviata: premi di nuovo per fermarla e salvare il file WAV (massimo 10 minuti)');
  screenWrap.focus();
});

$('demo').addEventListener('click', () => {
  startAudio();
  if (!romInfo.original) {
    toast('La demo usa FOR, POKE e numeri decimali: carica prima le ROM originali.');
    return;
  }
  c64.reset();
  if (disk) c64.mountDisk(disk, diskImage);
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
  updateDrive();
  updateDrive9();
  updateTape();
  if (now - fpsT > 1000) {
    const frames = framesRun - lastFrameCount;
    lastFrameCount = framesRun;
    const pct = Math.round((frames / ((now - fpsT) / 1000)) / c64.frameHz * 100);
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
applyPortDevices();
setupTouchControls();
updateRomStatus();
updateAudioStatus();
for (let i = 0; i < 120; i++) c64.runFrame(); // boot straight to READY.
draw();
requestAnimationFrame(loop);
