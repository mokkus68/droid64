// Machine-code monitor: write, disassemble, breakpoints, single steps, step over, side-effect-free peek
import { makeOrigC64 } from './util';
import { Monitor } from '../src/monitor';

const c = makeOrigC64();
for (let i = 0; i < 150; i++) c.runFrame();
const mon = new Monitor(() => c);
let resumed = '';
mon.onResume = (close) => { resumed = close ? 'x' : 'g'; };
const show = (cmd: string) => { const out = mon.exec(cmd); console.log(`.${cmd}\n` + out.map((l) => '  ' + l).join('\n')); return out; };

// C000: LDX #$00 / loop: INX / JSR $C010 / CPX #$05 / BNE loop / BRK      C010: INC $D020 / RTS
show('> c000 a2 00 e8 20 10 c0 e0 05 d0 f8 00');
show('> c010 ee 20 d0 60');
show('d c000 c00a');
show('b c006');
c.cpu.pc = 0xc000;
let frames = 0;
while (c.runFrame() && frames < 50) frames++;
console.log(`esecuzione fermata dal punto di arresto: ${c.breakHit} a PC=${c.cpu.pc.toString(16)} (atteso c006) X=${c.cpu.x}`);
show('r');
c.resumeFromBreak();
show('z 3');
// step over the JSR at C003 on the next loop
show('del c006');
while (c.cpu.pc !== 0xc003) c.stepInstruction();
const border = c.vic.regs[0x20];
show('n');
while (c.runFrame() && frames < 100) frames++;
if (mon.tempBreak >= 0) { c.breakpoints.delete(mon.tempBreak); mon.tempBreak = -1; }
console.log(`dopo "n": PC=${c.cpu.pc.toString(16)} (atteso c006), bordo cambiato ${border} → ${c.vic.regs[0x20]}, ripresa richiesta "${resumed}"`);
show('r a=42 x=7');
show('h c000 c020 e0 05');
show('m d020 d027');
// peek has no side effects: a pending CIA1 interrupt survives the monitor looking at $DC0D
c.cia1.write(0x0d, 0x7f); c.cia1.icrData = 0x81;
mon.exec('m dc00 dc0f');
console.log(`$DC0D dopo averlo guardato col monitor: ${c.cia1.icrData.toString(16)} (atteso 81, non cancellato)`);
show('pippo');
