// Saving to tape: the KERNAL writes pulses on the cassette write line, recorded as TAP data,
// then the same tape is verified and loaded back.
import { makeC64, makeOrigC64, screenText } from './util';
import { Tape, blankTap } from '../src/tape';
import { writeFileSync } from 'fs';

for (const [label, mk] of [['ROM originali', makeOrigC64], ['Open ROMs', makeC64]] as const) {
  if (label === 'ROM originali' && !process.env.ORIG) continue;
  const c = mk();
  const tape = new Tape(blankTap(), 'vuoto.tap');
  let changed = 0;
  tape.onChanged = () => changed++;
  c.insertTape(tape);
  for (let i = 0; i < 150; i++) c.runFrame();
  const orig = label === 'ROM originali';
  const prog = orig
    ? ['NEW', '10 PRINT"REGISTRATO SU NASTRO"', '20 FOR I=1 TO 3:PRINT I*I:NEXT']
    : ['NEW', '10 PRINT"REGISTRATO SU NASTRO"'];
  const screenTail = (n: number) => screenText(c).split('\n').filter((l) => l.trim()).slice(-n).join(' / ');
  const until = (text: string, max: number, cond: (s: string) => boolean, onFrame?: (s: string) => void) => {
    c.typeText(text);
    let f = 0;
    for (; f < max; f++) { c.runFrame(); const s = screenText(c); onFrame?.(s); if (!c.isTyping && f > 5 && cond(s)) break; }
    return f;
  };
  const doneAfter = (cmd: string) => (s: string) => s.lastIndexOf(cmd) >= 0 && s.trimEnd().endsWith('READY.') && s.lastIndexOf('READY.') > s.lastIndexOf(cmd);
  until(prog.join('\n') + '\n', 200, () => true);
  // SAVE: press RECORD + PLAY when asked
  const saveCmd = orig ? 'SAVE"PROVA"' : 'SAVE"PROVA",1';
  const f1 = until(saveCmd + '\n', 20000, doneAfter(saveCmd), (s) => { if (!tape.recording && /RECORD|PRESS|PLAY|OK/.test(s.trimEnd().slice(-120))) tape.startRecording(); });
  tape.stop();
  if (!orig) console.log('  dopo SAVE: ' + screenTail(4));
  console.log(`${label}: SAVE in ${f1} frame (${(f1 / 50).toFixed(0)} s emulati), nastro ${tape.length} byte, modifiche ${changed}`);
  // VERIFY and LOAD from the start of the tape
  const press = (s: string) => { if (!tape.playing && s.trimEnd().endsWith('PRESS PLAY ON TAPE')) tape.playing = true; };
  if (orig) {
    tape.rewind();
    until('VERIFY\n', 20000, doneAfter('VERIFY'), press);
    tape.stop();
    console.log('  verify: ' + screenTail(4));
  }
  tape.rewind();
  const loadCmd = orig ? 'LOAD' : 'LOAD"",1';
  until('NEW\n', 50, () => true);
  until(loadCmd + '\n', 20000, (s) => s.includes('LOADING') && doneAfter(loadCmd)(s), press);
  tape.stop();
  until('RUN\n', 100, (s) => s.includes('REGISTRATO SU NASTRO') && s.trimEnd().endsWith('READY.'));
  console.log('  load+run: ' + screenTail(orig ? 7 : 5));
  if (orig && process.argv[2]) writeFileSync(process.argv[2], tape.toTap());
}
