import { makeOrigC64, screenText, savePpm } from './util';
import { DEMO } from '../src/demo';
const c = makeOrigC64();
for (let i = 0; i < 160; i++) c.runFrame();
c.typeText(DEMO);
let maxAvail = 0;
for (let i = 0; i < 700; i++) { c.runFrame(); }
console.log(screenText(c));
console.log('sid avail', c.sid.available(), 'voice1 env', c.sid.voices[0].env.toFixed(1), 'freq', c.sid.voices[0].freq);
savePpm(c, process.argv[2]);
