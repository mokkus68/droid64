import { readFileSync } from 'fs';
import { CPU } from '../src/cpu';
const mem = new Uint8Array(65536);
mem.set(readFileSync(process.argv[2]));
const cpu = new CPU({ read: (a) => mem[a], write: (a, v) => { mem[a] = v; } });
cpu.pc = 0x400;
let last = -1, steps = 0;
const t0 = Date.now();
while (true) {
  cpu.step(); steps++;
  if (cpu.pc === last) break;
  last = cpu.pc;
}
console.log('stopped at', cpu.pc.toString(16), 'steps', steps, 'cycles', cpu.cycles, 'ms', Date.now() - t0);
console.log(cpu.pc === 0x3469 ? 'PASS' : 'FAIL');
