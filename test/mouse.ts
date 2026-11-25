// Mouse 1351 and paddles through SID POTX/POTY with CIA1 port selection
import { makeOrigC64 } from './util';
const c = makeOrigC64();
for (let i = 0; i < 150; i++) c.runFrame();
const pot = (port: 1 | 2, axis: 0 | 1) => { c.cia1.ddra = 0xff; c.cia1.pra = port === 1 ? 0x40 : 0x80; return c.read(0xd419 + axis); };
c.portDevice[1] = 'mouse';
const before = pot(1, 0);
c.mouseX += 5; c.mouseY += 3; // right 5, down 3
const dx = ((pot(1, 0) - before) & 0x7f) >> 1;
console.log('mouse porta 1: POTX', before, '→', pot(1, 0), 'spostamento X letto dal driver', dx, '(atteso 5) | POTY', pot(1, 1));
// a 1351 driver decoding: delta = ((new-old) & 0x7f); if >= 0x40 → negative; >> 1
let oldY = pot(1, 1); c.mouseY -= 4; // up 4
let d = (pot(1, 1) - oldY) & 0x7f; const dy = d >= 0x40 ? -((0x80 - d) >> 1) : d >> 1;
console.log('mouse su di 4: delta Y driver =', dy, '(atteso +4, il 1351 conta verso l\'alto)');
c.mouseButtons = 1; c.cia1.pra = 0xff; c.cia1.ddra = 0;
console.log('tasto sinistro → fuoco porta 1: $DC01 =', c.read(0xdc01).toString(2).padStart(8, '0'), '(bit 4 a 0)');
c.mouseButtons = 2;
console.log('tasto destro → su porta 1: $DC01 =', c.read(0xdc01).toString(2).padStart(8, '0'), '(bit 0 a 0)');
c.mouseButtons = 0;
c.portDevice[2] = 'paddle'; c.paddle = [17, 230]; c.paddleButtons = 3;
console.log('paddle porta 2: POTX', pot(2, 0), 'POTY', pot(2, 1), '| porta 1 con paddle selezionata la 2:', pot(2, 0) === 17);
c.cia1.pra = 0xff; c.cia1.ddra = 0;
console.log('tasti paddle → sinistra/destra porta 2: $DC00 =', c.read(0xdc00).toString(2).padStart(8, '0'), '(bit 2 e 3 a 0)');
