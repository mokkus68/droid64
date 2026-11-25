// REU 1750: stash / fetch / verify / swap through its registers at $DF00 (57088)
import { makeOrigC64, screenText } from './util';
const c = makeOrigC64();
c.setReu(512);
for (let i = 0; i < 150; i++) c.runFrame();
const prog = [
  '10 FOR I=0 TO 999:POKE 1024+I,1:NEXT',
  '20 B=57088:POKE B+2,0:POKE B+3,4:POKE B+4,0:POKE B+5,0:POKE B+6,6',
  '30 POKE B+7,232:POKE B+8,3:POKE B+10,0',
  '40 POKE B+1,176:S1=PEEK(B)',
  '50 FOR I=0 TO 999:POKE 1024+I,32:NEXT',
  '60 POKE B+1,177:S2=PEEK(B)',
  '70 POKE 1024,2:POKE B+1,179:S3=PEEK(B)',
  '80 PRINT CHR$(19);:FOR I=1 TO 22:PRINT:NEXT',
  '90 PRINT "STATO";S1;S2;S3',
  'RUN', '',
].join('\n');
c.typeText(prog);
for (let i = 0; i < 1500; i++) c.runFrame();
const lines = screenText(c).split('\n');
const as = Array.from(c.ram.subarray(0x400 + 1, 0x400 + 40 * 20)).filter((v) => v === 1).length;
console.log('schermo ripristinato dalla REU: celle "A" =', as, '/', 40 * 20 - 1, '| dati in REU banco 6:', c.reu!.ram[6 * 65536], c.reu!.ram[6 * 65536 + 999]);
console.log(lines.filter((l) => l.includes('STATO')).join(' '), '(attesi: 80 80 = fine blocco + REU 512K, poi 112 = verifica fallita)');
// REU contents survive a reset, like the real unit
c.reset();
console.log('dopo reset: dati ancora in REU =', c.reu!.ram[6 * 65536] === 1);
