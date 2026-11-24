import { makeC64, screenText, savePpm } from './util';
{

  const c = makeC64();
  const t0 = Date.now();
  for (let i = 0; i < 150; i++) c.runFrame();
  console.log('150 frames in', Date.now() - t0, 'ms; pc=', c.cpu.pc.toString(16));
  console.log(screenText(c));
  c.typeText('10 PRINT "HELLO";\n20 FOR I=1 TO 3:PRINT I*2:NEXT\nRUN\n');
  for (let i = 0; i < 200; i++) c.runFrame();
  console.log(screenText(c));
  savePpm(c, process.argv[2] ?? 'boot.ppm');
}
