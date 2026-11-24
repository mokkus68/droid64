import { makeOrigC64, screenText, savePpm } from './util';
const c = makeOrigC64();
for (let i = 0; i < 150; i++) c.runFrame();
// sprite + raster IRQ machine code ($C000): changes border colour at line 100 and back at line 200
// C000: SEI; LDA #<irq; STA $0314; LDA #>irq; STA $0315; LDA #$7F; STA $DC0D; LDA #1; STA $D01A;
//       LDA #100; STA $D012; LDA $D011; AND #$7F; STA $D011; CLI; RTS
// irq:  LDA $D012; CMP #150; BCS b; LDA #2; STA $D020; LDA #200; STA $D012; JMP x
//    b: LDA #14; STA $D020; LDA #100; STA $D012
//    x: ASL $D019; JMP $EA31
const prog = `10 FOR I=0 TO 62:POKE 832+I,255:NEXT
20 POKE 2040,13:POKE 53248,100:POKE 53249,120
25 POKE 53287,7:POKE 53269,1:POKE 53277,1
30 FOR I=0 TO 71:READ A:POKE 49152+I,A:NEXT:SYS 49152
40 PRINT "SPRITE TEST"
50 DATA 120,169,36,141,20,3,169,192,141,21,3,169,127,141
60 DATA 13,220,169,1,141,26,208,169,100,141,18,208,173,17
70 DATA 208,41,127,141,17,208,88,96,173,18,208,201,150,176
80 DATA 13,169,2,141,32,208,169,200,141,18,208,76,66,192
90 DATA 169,14,141,32,208,169,100,141,18,208,14,25,208,76
100 DATA 49,234
RUN
`;
c.typeText(prog);
for (let i = 0; i < 400; i++) c.runFrame();
console.log(screenText(c));
console.log('D019', c.vic.read(0x19).toString(16), 'pc', c.cpu.pc.toString(16));
savePpm(c, process.argv[2]);
