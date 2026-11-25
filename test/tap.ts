// Tape loading through the KERNAL from a .TAP image
import { makeC64, makeOrigC64, screenText } from './util';
import { Tape } from '../src/tape';
import { prgToTap } from './tapenc';
import { writeFileSync } from 'fs';

// 10 PRINT"DAL NASTRO!" : 20 FOR I=1 TO 3: PRINT I: NEXT (tokenized by hand)
const basic = [0x01, 0x08,
  0x13, 0x08, 0x0a, 0x00, 0x99, 0x22, ...Array.from('DAL NASTRO!', (c) => c.charCodeAt(0)), 0x22, 0x00,
  0x26, 0x08, 0x14, 0x00, 0x81, 0x49, 0xb2, 0x31, 0xa4, 0x33, 0x3a, 0x99, 0x49, 0x3a, 0x82, 0x00,
  0x00, 0x00];
// fix the link of line 20
basic[0x13 - 0x01 + 2 - 0x08 * 0] = basic[0x13 - 0x01 + 2];
const prg = new Uint8Array(basic);
// recompute line links properly
{
  const mem = prg.subarray(2); let a = 0x0801;
  let i = 0;
  while (i < mem.length - 2) {
    let j = i + 4; while (mem[j] !== 0) j++;
    const next = 0x0801 + j + 1;
    if (mem[j + 1] === 0 && mem[j + 2] === 0 && j + 3 >= mem.length) { mem[i] = next & 255; mem[i + 1] = next >> 8; break; }
    mem[i] = next & 255; mem[i + 1] = next >> 8; i = j + 1; a = next;
  }
}
const tap = prgToTap(prg, 'NASTRO');
if (process.argv[2]) writeFileSync(process.argv[2], tap);
for (const [label, mk] of [['ROM originali', makeOrigC64], ['Open ROMs', makeC64]] as const) {
  if (label === 'ROM originali' && !process.env.ORIG) continue;
  const c = mk();
  const tape = new Tape(tap, 'nastro.tap');
  c.insertTape(tape);
  for (let i = 0; i < 150; i++) c.runFrame();
  c.typeText(label === 'Open ROMs' ? 'LOAD"",1\n' : 'LOAD\n');
  let pressed = false, f = 0;
  for (; f < 20000; f++) {
    c.runFrame();
    const s = screenText(c);
    if (!pressed && s.includes('PLAY')) { tape.playing = true; pressed = true; }
    if (pressed && f > 10 && s.trimEnd().endsWith('READY.') && s.lastIndexOf('READY.') > s.lastIndexOf('LOAD')) break;
  }
  c.typeText('RUN\n');
  for (let i = 0; i < 100; i++) c.runFrame();
  console.log(`${label}: ${f} frame (${(f / 50).toFixed(0)} s emulati), nastro al ${(tape.progress * 100).toFixed(0)}%`);
  console.log('  ' + screenText(c).split('\n').filter((l) => l.trim()).slice(-9).join(' / '));
}
