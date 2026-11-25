import { makeOrigC64, screenText } from './util';
const c = makeOrigC64();
for (let i = 0; i < 150; i++) c.runFrame();
c.typeText('LOAD"X",8\nOPEN15,8,15:PRINT"OK"\n');
for (let i = 0; i < 400; i++) c.runFrame();
console.log(screenText(c).split('\n').filter((l) => l.trim()).slice(-6).join('\n'));
console.log('pc', c.cpu.pc.toString(16));
