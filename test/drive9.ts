// Two drives: devices 8 and 9, virtual or emulated 1541s on the same serial bus
import { makeOrigC64, screenText } from './util';
import { parseD64 } from '../src/media';
import { blankD64, writeFile } from '../src/d64write';
import { readFileSync } from 'fs';

const rom = process.env.DRIVEROM ? new Uint8Array(readFileSync(process.env.DRIVEROM)) : null;
const prg = (text: string) => Uint8Array.from([0x01, 0x08, 0x10, 0x08, 0x0a, 0x00, 0x99, 0x22, ...Array.from(text, (c) => c.charCodeAt(0)), 0x22, 0x00, 0x00, 0x00]);

for (const mode of rom ? ['virtuale', '1541 emulati'] as const : ['virtuale'] as const) {
  const disk8 = blankD64('DISCO OTTO', '08');
  const disk9 = blankD64('DISCO NOVE', '09');
  writeFile(disk8, Uint8Array.from('UNO', (c) => c.charCodeAt(0)), 'PRG', prg('DAL DRIVE 8!'));
  writeFile(disk9, Uint8Array.from('DUE', (c) => c.charCodeAt(0)), 'PRG', prg('DAL DRIVE 9!'));
  const c = makeOrigC64();
  c.enableDrive9(true);
  if (mode !== 'virtuale') c.attachDrive(rom);
  c.mountDisk(parseD64(disk8), disk8);
  c.mountDisk(parseD64(disk9), disk9, false, 9);
  for (let i = 0; i < 150; i++) c.runFrame();
  const run = (text: string, frames: number) => { c.typeText(text); for (let i = 0; i < frames; i++) c.runFrame(); };
  const slow = mode === 'virtuale' ? 1 : 12;
  run('LOAD"$",9\n', 60 * slow); run('LIST\n', 30);
  const dirLine = screenText(c).split('\n').find((l) => l.includes('DISCO NOVE'))?.trim();
  run('LOAD"DUE",9\n', 60 * slow); run('RUN\n', 30);
  const r9 = screenText(c).includes('DAL DRIVE 9!');
  run('LOAD"UNO",8\n', 60 * slow); run('RUN\n', 30);
  const r8 = screenText(c).includes('DAL DRIVE 8!');
  // copy UNO from drive 8 to drive 9 with both files open at once
  run([
    'NEW',
    '10 OPEN 2,8,2,"UNO,P,R":OPEN 3,9,3,"COPIA,P,W"',
    '20 GET#2,A$:S=ST:PRINT#3,CHR$(ASC(A$+CHR$(0)));:IF S=0 THEN 20',
    '30 CLOSE 3:CLOSE 2:PRINT "COPIATO"',
    'RUN', '',
  ].join('\n'), 300 * slow);
  if (mode !== 'virtuale') for (let i = 0; i < 400; i++) c.runFrame(); // let the drive 9 motor stop (decode writes)
  const d9 = parseD64(disk9);
  const copia = d9.files.find((f) => f.name === 'COPIA');
  const uno = parseD64(disk8).files.find((f) => f.name === 'UNO');
  const same = !!copia?.data && !!uno?.data && copia.data.length === uno.data.length && copia.data.every((v, i) => v === uno.data![i]);
  console.log(`${mode}: directory drive 9 "${dirLine}" | LOAD da 9 ${r9} | LOAD da 8 ${r8} | copia 8→9 ${screenText(c).includes('COPIATO') ? 'eseguita' : '?'}, identica ${same} | file sul 9: ${d9.files.map((f) => f.name).join(', ')}`);
}
