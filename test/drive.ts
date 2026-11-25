// Real 1541 emulation: the C64 KERNAL talks to the drive's own DOS over the serial bus.
import { makeOrigC64, screenText } from './util';
import { parseD64 } from '../src/media';
import { readFileSync } from 'fs';

const img = new Uint8Array(readFileSync(process.argv[2]));
const rom = new Uint8Array(readFileSync(process.env.DRIVEROM!));
const c = makeOrigC64();
c.attachDrive(rom);
c.mountDisk(parseD64(img), img);
const t0 = Date.now();
for (let i = 0; i < 150; i++) c.runFrame();
const run = (text: string, maxFrames: number, until: (s: string) => boolean) => {
  c.typeText(text);
  let f = 0;
  for (; f < maxFrames; f++) { c.runFrame(); if (!c.isTyping && until(screenText(c))) break; }
  return f;
};
const frames1 = run('LOAD"$",8\n', 3000, (s) => /READY\.\s*$/.test(s.trimEnd()) && s.includes('LOAD"$",8') && s.lastIndexOf('READY.') > s.indexOf('LOAD"$"'));
const frames2 = run('LIST\n', 300, (s) => s.includes('BLOCKS FREE'));
const frames3 = run('LOAD"HELLO",8\n', 3000, (s) => s.lastIndexOf('READY.') > s.lastIndexOf('LOAD"HELLO"'));
const frames4 = run('RUN\n', 200, (s) => s.includes('HI!'));
console.log(screenText(c).split('\n').filter((l) => l.trim()).slice(-14).join('\n'));
console.log(`frame: dir ${frames1}, list ${frames2}, load ${frames3}, run ${frames4} | tempo reale ${Date.now() - t0} ms | traccia testina ${c.drive!.halftrack / 2}`);
