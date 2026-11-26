// Machine-code monitor: registers, memory, disassembly, breakpoints, single steps (VICE-style commands).

import { C64 } from './c64';
import { disassemble, instructionLength } from './cpu';

const h2 = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');
const h4 = (v: number) => v.toString(16).toUpperCase().padStart(4, '0');

export const MONITOR_HELP = [
  'Comandi (numeri in esadecimale, il $ è facoltativo):',
  '  r                      registri;  r pc=c000 a=00 x=00 y=00 sp=ff  per cambiarli',
  '  m [inizio [fine]]      memoria (senza inizio: continua da dove eri)',
  '  d [inizio [fine]]      disassembla (senza inizio: dal PC o da dove eri)',
  '  > indirizzo byte …     scrive byte in memoria',
  '  f inizio fine byte     riempie un intervallo',
  '  h inizio fine byte …   cerca una sequenza di byte',
  '  b [indirizzo]          imposta un punto di arresto (senza argomento: elenco)',
  '  del indirizzo | tutti  toglie un punto di arresto o tutti',
  '  z [n]                  esegue 1 (o n) istruzioni',
  '  n                      esegue un passo saltando le subroutine (JSR)',
  '  g [indirizzo]          riprende l\'esecuzione (dal PC o dall\'indirizzo)',
  '  x                      riprende e chiude il monitor',
  '  ?                      questo aiuto',
];

export class Monitor {
  private nextMem = -1;
  private nextDis = -1;
  /** temporary breakpoint used by "n" (step over) */
  tempBreak = -1;
  /** asked the caller to resume (g) or to resume and close (x) */
  onResume: (close: boolean) => void = () => {};

  constructor(private c64: () => C64) {}

  private peek(a: number) { return this.c64().peek(a & 0xffff); }

  registers(): string {
    const cpu = this.c64().cpu;
    const flags = ['N', 'V', '-', 'B', 'D', 'I', 'Z', 'C'].map((f, i) => ((cpu.getP() >> (7 - i)) & 1 ? f : '.')).join('');
    const vic = this.c64().vic;
    return `PC=${h4(cpu.pc)} A=${h2(cpu.a)} X=${h2(cpu.x)} Y=${h2(cpu.y)} SP=${h2(cpu.s)} ${flags}  riga ${vic.raster}  ciclo ${cpu.cycles}`;
  }

  /** The instruction at PC, for the status line after a step or a break. */
  here(): string {
    const pc = this.c64().cpu.pc;
    return this.disLine(pc);
  }

  private disLine(a: number): string {
    const d = disassemble((x) => this.peek(x), a);
    const bp = this.c64().breakpoints.has(a) ? '●' : ' ';
    const bytes = d.bytes.map(h2).join(' ').padEnd(8);
    return `${bp}.${h4(a)}  ${bytes}  ${d.text}${d.illegal ? '   (non documentata)' : ''}`;
  }

  private disassembleFrom(start: number, end: number | null, count = 20): string[] {
    const out: string[] = [];
    let a = start;
    for (let i = 0; end !== null ? a <= end && i < 2000 : i < count; i++) {
      out.push(this.disLine(a));
      a = (a + instructionLength(this.peek(a))) & 0xffff;
      if (end !== null && a < start) break;
    }
    this.nextDis = a;
    return out;
  }

  private memory(start: number, end: number): string[] {
    const out: string[] = [];
    for (let a = start; a <= end; a += 8) {
      const bytes: number[] = [];
      for (let i = 0; i < 8 && a + i <= 0xffff; i++) bytes.push(this.peek(a + i));
      const text = bytes.map((b) => { const c = b & 0x7f; return c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '.'; }).join('');
      out.push(`>${h4(a)}  ${bytes.map(h2).join(' ').padEnd(23)}  ${text}`);
      if (a + 8 > 0xffff) break;
    }
    this.nextMem = (end + 1) & 0xffff;
    return out;
  }

  /** Run one command line; returns the lines to print. */
  exec(line: string): string[] {
    const t = line.trim();
    if (!t) return [];
    const m = /^(\S+)\s*(.*)$/.exec(t)!;
    let cmd = m[1].toLowerCase();
    let rest = m[2];
    if (cmd.startsWith('>')) { rest = cmd.slice(1) + ' ' + rest; cmd = '>'; }
    const nums = rest.split(/[\s,]+/).filter(Boolean);
    const num = (s: string | undefined) => {
      if (s === undefined) return NaN;
      const v = parseInt(s.replace(/^\$/, ''), 16);
      return Number.isFinite(v) ? v : NaN;
    };
    const c = this.c64();
    const bad = (msg: string) => [`? ${msg}`];
    switch (cmd) {
      case '?': case 'help': case 'aiuto': return MONITOR_HELP;
      case 'r': {
        if (!nums.length) return [this.registers()];
        for (const p of rest.split(/[\s,]+/).filter(Boolean)) {
          const [k, v] = p.split('=');
          const n = num(v);
          if (Number.isNaN(n)) return bad(`valore non valido: ${p}`);
          switch (k.toLowerCase()) {
            case 'pc': c.cpu.pc = n & 0xffff; break;
            case 'a': c.cpu.a = n & 0xff; break;
            case 'x': c.cpu.x = n & 0xff; break;
            case 'y': c.cpu.y = n & 0xff; break;
            case 'sp': case 's': c.cpu.s = n & 0xff; break;
            case 'p': case 'fl': c.cpu.setP(n & 0xff); break;
            default: return bad(`registro sconosciuto: ${k}`);
          }
        }
        return [this.registers()];
      }
      case 'm': {
        const s = nums.length ? num(nums[0]) : this.nextMem >= 0 ? this.nextMem : c.cpu.pc;
        if (Number.isNaN(s)) return bad('indirizzo non valido');
        const e = nums.length > 1 ? num(nums[1]) : Math.min(0xffff, s + 0x7f);
        if (Number.isNaN(e) || e < s) return bad('intervallo non valido');
        return this.memory(s, Math.min(e, s + 0xfff));
      }
      case 'd': {
        const s = nums.length ? num(nums[0]) : this.nextDis >= 0 ? this.nextDis : c.cpu.pc;
        if (Number.isNaN(s)) return bad('indirizzo non valido');
        const e = nums.length > 1 ? num(nums[1]) : null;
        if (e !== null && (Number.isNaN(e) || e < s)) return bad('intervallo non valido');
        return this.disassembleFrom(s, e);
      }
      case '>': {
        const a = num(nums[0]);
        const bytes = nums.slice(1).map(num);
        if (Number.isNaN(a) || !bytes.length || bytes.some(Number.isNaN)) return bad('uso: > indirizzo byte …');
        bytes.forEach((b, i) => c.write((a + i) & 0xffff, b & 0xff));
        return this.memory(a, Math.min(0xffff, a + Math.max(7, bytes.length - 1)));
      }
      case 'f': {
        const [s, e, v] = nums.map(num);
        if ([s, e, v].some(Number.isNaN) || e < s) return bad('uso: f inizio fine byte');
        for (let a = s; a <= e; a++) c.write(a, v & 0xff);
        return [`riempito ${h4(s)}-${h4(e)} con ${h2(v & 0xff)}`];
      }
      case 'h': {
        const [s, e, ...pat] = nums.map(num);
        if ([s, e, ...pat].some(Number.isNaN) || !pat.length || e < s) return bad('uso: h inizio fine byte …');
        const found: string[] = [];
        for (let a = s; a <= e - pat.length + 1 && found.length < 64; a++) {
          if (pat.every((b, i) => this.peek(a + i) === (b & 0xff))) found.push(h4(a));
        }
        return found.length ? [`trovato in: ${found.join(' ')}`] : ['non trovato'];
      }
      case 'b': case 'break': {
        if (!nums.length) {
          const list = [...c.breakpoints].sort((x, y) => x - y);
          return list.length ? list.map((a) => `punto di arresto  ${this.disLine(a)}`) : ['nessun punto di arresto'];
        }
        const a = num(nums[0]);
        if (Number.isNaN(a)) return bad('indirizzo non valido');
        c.breakpoints.add(a & 0xffff);
        return [`punto di arresto a ${h4(a)}`];
      }
      case 'del': {
        if (!nums.length) return bad('uso: del indirizzo | tutti');
        if (/^(tutti|all|\*)$/i.test(nums[0])) { c.breakpoints.clear(); return ['tutti i punti di arresto tolti']; }
        const a = num(nums[0]);
        if (Number.isNaN(a) || !c.breakpoints.delete(a & 0xffff)) return bad(`nessun punto di arresto a ${nums[0]}`);
        return [`tolto il punto di arresto a ${h4(a)}`];
      }
      case 'z': {
        const n = nums.length ? Math.max(1, Math.min(10000, num(nums[0]) || 1)) : 1;
        const out: string[] = [];
        for (let i = 0; i < n; i++) {
          c.stepInstruction();
          if (n <= 20 || i >= n - 20) out.push(this.here());
          if (c.breakpoints.has(c.cpu.pc) && i < n - 1) { out.push('(punto di arresto)'); break; }
        }
        this.nextDis = -1;
        out.push(this.registers());
        return out;
      }
      case 'n': {
        const op = this.peek(c.cpu.pc);
        if (op !== 0x20) return this.exec('z');
        // JSR: run until the instruction after it
        this.tempBreak = (c.cpu.pc + 3) & 0xffff;
        c.breakpoints.add(this.tempBreak);
        this.onResume(false);
        return [`eseguo la subroutine fino a ${h4(this.tempBreak)}…`];
      }
      case 'g': {
        if (nums.length) {
          const a = num(nums[0]);
          if (Number.isNaN(a)) return bad('indirizzo non valido');
          c.cpu.pc = a & 0xffff;
        }
        this.onResume(false);
        return ['in esecuzione'];
      }
      case 'x': this.onResume(true); return [];
      default: return bad(`comando sconosciuto "${cmd}": scrivi ? per l'aiuto`);
    }
  }
}
