import { makeOrigC64 } from './util';
import { parseD64 } from '../src/media';
import { readFileSync } from 'fs';
const img = new Uint8Array(readFileSync(process.argv[2]));
for (const withDrive of [false, true]) {
  const c = makeOrigC64();
  if (withDrive) c.attachDrive(new Uint8Array(readFileSync(process.env.DRIVEROM!)));
  c.mountDisk(parseD64(img), img);
  for (let i = 0; i < 100; i++) c.runFrame();
  const t0 = performance.now();
  for (let i = 0; i < 500; i++) c.runFrame();
  const ms = (performance.now() - t0) / 500;
  console.log(withDrive ? 'con 1541 ' : 'senza 1541', ms.toFixed(2), 'ms/frame →', (20 / ms).toFixed(1) + 'x tempo reale');
}
