import { C64, Roms, FRAME_HZ } from './c64';
import { SCREEN_W, SCREEN_H, PALETTE } from './vic';
import { KeyboardMapper, JOY_KEYS } from './keyboard';
import { parseD64, parseT64, D64File, DiskImage } from './media';
import { OPEN_BASIC, OPEN_KERNAL, OPEN_CHARGEN } from './roms';
import { DEMO } from './demo';
import { buildKeyboard } from './vkbd';
import { Cartridge } from './cartridge';
import { blankD64 } from './d64write';
import { Tape, blankTap } from './tape';

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
  if (disk) c64.mountDisk(disk, diskImage);
  wireMachine();
  if (cartridge) c64.insertCartridge(cartridge);
  if (tape) c64.insertTape(tape);
  c64.setReu(reuSize);
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
  c64.onDriveActivity = () => flashDrive();
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
    } else if (name.endsWith('.d64') || data.length === 174848 || data.length === 175531 || data.length === 196608) {
      const saved = loadSavedDisk(f.name);
      originalImage = data.slice();
      const img = saved && saved.length === data.length ? saved : data;
      insertD64(img, f.name, !!saved);
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

function insertD64(img: Uint8Array, name: string, modified: boolean) {
  disk = parseD64(img);
  diskImage = img;
  diskName = name;
  diskModified = modified;
  c64.mountDisk(disk, diskImage);
  showDirectory(name);
}

/** Called whenever the emulated drive writes to the mounted disk. */
function onDiskChanged() {
  if (!diskImage) return;
  disk = c64.disk ?? parseD64(diskImage);
  diskModified = true;
  showDirectory(diskName);
  flashDrive();
  store.set(diskKey(diskName), bytesToB64(diskImage));
  if (store.get(diskKey(diskName)) === null) toast('Spazio del browser esaurito: scarica il disco con “Scarica .d64” per non perdere le modifiche');
  else if (c64.drive) toast('Disco aggiornato dal 1541: le modifiche sono salvate in questo browser');
  renderSavedDisks();
}

function onDiskSave(name: string, code: number) {
  if (code === 0) toast(`Salvato su disco: ${name}`);
  else if (code === 63) toast(`Sul disco esiste già “${name}”. Per sostituirlo: SAVE"@0:${name}",8`);
  else if (code === 26) toast('Questo disco è protetto da scrittura (i file .T64 non si possono modificare)');
  else toast('Disco pieno: il file non è stato salvato');
}

$('download-disk').addEventListener('click', () => {
  if (!diskImage) return;
  c64.drive?.flushWrites();
  const name = /\.d64$/i.test(diskName) ? diskName : diskName.replace(/\.[^.]*$/, '') + '.d64';
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
  let n = 1;
  while (store.get(diskKey(`disco${n}.d64`))) n++;
  originalImage = null;
  insertD64(blankD64(`DISCO ${n}`, String(n).padStart(2, '0')), `disco${n}.d64`, false);
  store.set(diskKey(diskName), bytesToB64(diskImage!));
  renderSavedDisks();
  toast(`Disco vuoto “disco${n}.d64” inserito nel drive 8. Salva con SAVE"NOME",8`);
  screenWrap.focus();
});

window.addEventListener('pagehide', () => { c64.drive?.flushWrites(); });

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
    li.append(open, del);
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
  updateTape();
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
applyPortDevices();
setupTouchControls();
updateRomStatus();
updateAudioStatus();
for (let i = 0; i < 120; i++) c64.runFrame(); // boot straight to READY.
draw();
requestAnimationFrame(loop);
