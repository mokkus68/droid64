// Saving to disk with the virtual drive: SAVE, SEQ files, scratch, rename, format
import { makeC64, makeOrigC64, screenText } from './util';
import { parseD64 } from '../src/media';
import { blankD64 } from '../src/d64write';
import { readFileSync } from 'fs';

for (const [label, mk] of [['ROM originali', makeOrigC64], ['Open ROMs', makeC64]] as const) {
  if (label === 'ROM originali' && !process.env.ORIG) continue;
  const img = blankD64('PROVA', 'AB');
  const c = mk();
  c.mountDisk(parseD64(img), img);
  let changes = 0;
  c.onDiskChanged = () => changes++;
  for (let i = 0; i < 150; i++) c.runFrame();
  // a program larger than one block, saved and loaded back
  const lines = ['NEW'];
  for (let n = 10; n <= 300; n += 10) lines.push(`${n} PRINT "RIGA ${n} DEL PROGRAMMA SALVATO SU DISCO"`);
  lines.push('SAVE"PROGRAMMA",8', 'NEW', 'LOAD"PROGRAMMA",8', 'LIST 290-300', '');
  c.typeText(lines.join('\n'));
  for (let i = 0; i < 800; i++) c.runFrame();
  const after = parseD64(img);
  console.log(`${label}: file sul disco = ${after.files.map((f) => `${f.name}(${f.blocks} blocchi, ${f.type})`).join(', ')} | blocchi liberi ${after.freeBlocks} | modifiche ${changes}`);
  console.log('  schermo:', screenText(c).split('\n').filter((l) => l.trim()).slice(-3).join(' / '));
  if (label === 'ROM originali') {
    c.typeText([
      'NEW',
      '10 OPEN2,8,2,"DATI,S,W":PRINT#2,"CIAO DAL DISCO":CLOSE2',
      '20 OPEN2,8,2,"DATI,S,R":INPUT#2,A$:CLOSE2:PRINT"LETTO: ";A$',
      '30 OPEN15,8,15,"R0:NUOVO=PROGRAMMA":INPUT#15,E,E$:PRINT"RINOMINA";E;E$:CLOSE15',
      '40 SAVE"DATI",8:OPEN15,8,15:INPUT#15,E,E$:PRINT"RISALVA";E;E$:CLOSE15',
      '50 OPEN15,8,15,"S0:DATI":INPUT#15,E,E$,T:PRINT"CANCELLA";E;E$;T:CLOSE15',
      'RUN', '',
    ].join('\n'));
    for (let i = 0; i < 600; i++) c.runFrame();
    console.log('  ' + screenText(c).split('\n').filter((l) => /LETTO|RINOMINA|RISALVA|CANCELLA/.test(l) && !/^\d/.test(l.trim())).join(' / '));
    const fin = parseD64(img);
    console.log('  file finali:', fin.files.map((f) => f.name).join(', '), '| blocchi liberi', fin.freeBlocks);
  }
}
