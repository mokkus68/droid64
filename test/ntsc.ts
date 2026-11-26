// PAL and NTSC machines: KERNAL detection, frame rate, jiffy clock, disk and tape loads
import { makeOrigC64, screenText } from './util';
import { parseD64 } from '../src/media';
import { Tape } from '../src/tape';
import { prgToTap } from './tapenc';
import { readFileSync } from 'fs';

const d64 = new Uint8Array(readFileSync(process.argv[2]));
const rom = process.env.DRIVEROM ? new Uint8Array(readFileSync(process.env.DRIVEROM)) : null;
const hello = parseD64(d64).files.find((f) => f.name === 'HELLO')!.data!;

for (const ntsc of [false, true]) {
  const c = makeOrigC64();
  c.setStandard(ntsc);
  for (let i = 0; i < 200; i++) c.runFrame();
  let maxRaster = 0;
  const jiffy = () => c.ram[0xa2] | (c.ram[0xa1] << 8) | (c.ram[0xa0] << 16);
  const j0 = jiffy();
  const frames = Math.round(c.frameHz * 10); // ten emulated seconds
  for (let i = 0; i < frames; i++) { c.runFrame(); }
  for (let l = 0; l < 30000; l++) { maxRaster = Math.max(maxRaster, c.vic.raster); c.stepInstruction(); }
  const perSec = (jiffy() - j0) / 10;
  // disk through an emulated 1541, then tape
  const results: string[] = [];
  if (rom) {
    c.attachDrive(rom); c.setStandard(ntsc);
    c.mountDisk(parseD64(d64), d64);
    for (let i = 0; i < 200; i++) c.runFrame();
    c.typeText('LOAD"HELLO",8\nRUN\n');
    for (let i = 0; i < 900; i++) c.runFrame();
    results.push(`1541 ${screenText(c).includes('HI!') ? 'ok' : 'NO'}`);
    c.attachDrive(null);
  }
  const t = new Tape(prgToTap(hello, 'HELLO'), 't.tap');
  c.insertTape(t);
  c.reset();
  for (let i = 0; i < 200; i++) c.runFrame();
  c.typeText('LOAD\n'); t.playing = true;
  for (let i = 0; i < 4000; i++) {
    c.runFrame();
    const sc = screenText(c);
    if (sc.includes('LOADING') && sc.lastIndexOf('READY.') > sc.lastIndexOf('LOADING')) break;
  }
  c.typeText('RUN\n');
  for (let i = 0; i < 60; i++) c.runFrame();
  results.push(`nastro ${screenText(c).includes('HI!') ? 'ok' : 'NO'}`);
  console.log(`${ntsc ? 'NTSC' : 'PAL '}: KERNAL $02A6=${c.ram[0x2a6]} | ${c.vic.linesPerFrame} righe × ${c.vic.cyclesPerLine} cicli, ${c.frameHz.toFixed(3)} frame/s, riga massima ${maxRaster} | orologio TI ${perSec.toFixed(1)} tic/s | ${results.join(' | ')}`);
}
