// Datasette counter: non-linear like the take-up reel, reset button, rewind.
import { Tape, blankTap } from '../src/tape';
import { makeOrigC64 } from './util';
import { prgToTap } from './tapenc';

const t = new Tape(blankTap(), 'x.tap');
const at = (min: number) => { t.elapsed = min * 60 * 985248; return t.counter; };
console.log('contagiri dopo 1, 5, 10, 20, 30 minuti:', [1, 5, 10, 20, 30].map(at).join(', '));
at(10); t.resetCounter();
console.log('azzerato a 10 min → subito', t.counter, '| dopo altri 5 min', at(15));
t.rewind();
console.log('dopo riavvolgimento:', t.counter, '(conta all\'indietro dal punto di azzeramento, come il contatore vero)');

// counting during a real KERNAL load
if (process.env.ORIG) {
  const prg = new Uint8Array(2 + 4000); prg[0] = 0x01; prg[1] = 0x08;
  const tape = new Tape(prgToTap(prg, 'LUNGO'), 'lungo.tap');
  const c = makeOrigC64();
  c.insertTape(tape);
  for (let i = 0; i < 150; i++) c.runFrame();
  c.typeText('LOAD\n');
  tape.playing = true;
  let f = 0;
  for (; f < 30000 && !tape.atEnd; f++) { c.runFrame(); if (f > 300 && !tape.motor && c.cpu.pc >= 0xe000 && tape.elapsed > 0 && tape.progress > 0.9) break; }
  console.log(`caricamento KERNAL: ${(f / 50).toFixed(0)} s emulati, contagiri ${tape.counter}`);
}
