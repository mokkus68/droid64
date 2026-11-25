// Writing with the emulated 1541: the drive's own DOS writes GCR, decoded back into the D64 image.
import { makeOrigC64, screenText } from './util';
import { parseD64 } from '../src/media';
import { blankD64 } from '../src/d64write';
import { readFileSync } from 'fs';

const img = blankD64('PROVA', 'AB');
const c = makeOrigC64();
c.attachDrive(new Uint8Array(readFileSync(process.env.DRIVEROM!)));
c.mountDisk(parseD64(img), img);
let changes = 0;
c.onDiskChanged = () => changes++;
for (let i = 0; i < 150; i++) c.runFrame();
const runUntil = (text: string, max: number, done: (s: string) => boolean) => {
  c.typeText(text);
  for (let f = 0; f < max; f++) { c.runFrame(); if (!c.isTyping && done(screenText(c))) return f; }
  return -1;
};
const lines = ['NEW'];
for (let n = 10; n <= 300; n += 10) lines.push(`${n} PRINT "RIGA ${n} DEL PROGRAMMA SALVATO SU DISCO"`);
runUntil(lines.join('\n') + '\n', 400, () => true);
const ready = (s: string) => s.trimEnd().endsWith('READY.');
const f1 = runUntil('SAVE"PROGRAMMA",8\n', 6000, ready);
const f2 = runUntil('VERIFY"PROGRAMMA",8\n', 6000, ready);
console.log(screenText(c).split('\n').filter((l) => l.trim()).slice(-6).join(' / '));
const f3 = runUntil('NEW\nLOAD"PROGRAMMA",8\n', 6000, (s) => ready(s) && s.includes('LOADING'));
runUntil('LIST 290-300\n', 100, (s) => s.includes('RIGA 300'));
console.log(screenText(c).split('\n').filter((l) => l.trim()).slice(-3).join(' / '));
const f4 = runUntil('OPEN15,8,15,"R0:NUOVO=PROGRAMMA":CLOSE15\n', 6000, ready);
const f5 = runUntil('SAVE"SECONDO",8\n', 6000, ready);
const f6 = runUntil('OPEN15,8,15,"S0:SECONDO":CLOSE15\n', 6000, ready);
for (let i = 0; i < 300; i++) c.runFrame(); // let the motor stop so the last writes are decoded
const d = parseD64(img);
console.log(`frame: save ${f1}, verify ${f2}, load ${f3}, rename ${f4}, save2 ${f5}, scratch ${f6} | aggiornamenti immagine ${changes}`);
console.log('file nell\'immagine D64:', d.files.map((f) => `${f.name}(${f.blocks})`).join(', '), '| blocchi liberi', d.freeBlocks);
const prog = d.files.find((f) => f.name === 'NUOVO');
console.log('contenuto NUOVO:', prog?.data ? `${prog.data.length} byte, inizio $${(prog.data[0] | (prog.data[1] << 8)).toString(16)}` : 'mancante');
