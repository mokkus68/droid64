// Disk access through the KERNAL serial routines (OPEN / GET# / INPUT# / command channel),
// as used by many game loaders, as opposed to the plain LOAD command.
import { makeC64, makeOrigC64, screenText } from './util';
import { parseD64 } from '../src/media';
import { readFileSync } from 'fs';

const disk = parseD64(new Uint8Array(readFileSync(process.argv[2])));
const mk = process.env.ORIG ? makeOrigC64 : makeC64;
const c = mk();
c.mountDisk(disk, new Uint8Array(readFileSync(process.argv[2])));
c.onFastloader = () => console.log("  [fastloader rilevato]");
for (let i = 0; i < 150; i++) c.runFrame();
c.typeText([
  '10 OPEN15,8,15:INPUT#15,A,B$:PRINT"STATO";A;B$',
  '20 OPEN2,8,2,"HELLO":FORI=1TO6:GET#2,X$:PRINTASC(X$+CHR$(0));:NEXT:CLOSE2:PRINT',
  '30 OPEN3,8,3,"NOPE":GET#3,X$:PRINT"ST";ST:CLOSE3',
  '40 INPUT#15,A,B$:PRINT"STATO";A;B$',
  '50 PRINT#15,"UI":INPUT#15,A,B$:PRINTA;B$',
  '60 OPEN4,8,4,"#":PRINT#15,"U1 4 0 18 0":GET#4,T$,S$',
  '65 PRINT"BAM";ASC(T$);ASC(S$+CHR$(0))',
  '70 CLOSE4:OPEN1,8,0,"$":GET#1,X$,Y$:PRINT"DIR";ASC(X$);ASC(Y$):CLOSE1:CLOSE15',
  'RUN',
  '',
].join('\n'));
for (let i = 0; i < 500; i++) c.runFrame();
console.log(screenText(c).split('\n').filter((l) => l.trim()).slice(-14).join('\n'));
