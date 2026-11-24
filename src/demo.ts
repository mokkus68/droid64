// a ball sprite drawn for this demo, 24×21 pixels
const BALL = (() => {
  const out: number[] = [];
  for (let y = 0; y < 21; y++) {
    for (let b = 0; b < 3; b++) {
      let v = 0;
      for (let x = 0; x < 8; x++) {
        const px = b * 8 + x, dx = px - 11.5, dy = y - 10;
        if (dx * dx + dy * dy <= 100) v |= 0x80 >> x;
      }
      out.push(v);
    }
  }
  return out;
})();
export const DEMO = [
  'NEW',
  '10 POKE53280,6:POKE53281,0:PRINTCHR$(147);CHR$(5)',
  '20 PRINT" CIAO! QUESTO E\' IL BASIC V2 DEL C64":PRINT',
  '30 FORI=0TO15:POKE1144+I*2,160:POKE55416+I*2,I:NEXT',
  '40 FORI=0TO62:READA:POKE832+I,A:NEXT',
  '50 POKE2040,13:POKE53287,7:POKE53269,1',
  '60 S=54272:POKES+24,15:POKES+5,9:POKES+6,0',
  '70 X=60:Y=90:DX=3:DY=2',
  '80 X=X+DX:IFX<24ORX>320THENDX=-DX:GOSUB200',
  '90 Y=Y+DY:IFY<50ORY>229THENDY=-DY:GOSUB200',
  '100 POKE53248,XAND255:POKE53264,-(X>255):POKE53249,Y',
  '110 GETK$:IFK$=""THEN80',
  '120 POKE53269,0:POKES+24,0:END',
  '200 POKES+1,10+RND(1)*40:POKES+4,16:POKES+4,17:RETURN',
  ...Array.from({ length: Math.ceil(BALL.length / 16) }, (_, i) => `${300 + i * 10} DATA${BALL.slice(i * 16, i * 16 + 16).join(',')}`),
  'RUN',
  '',
].join('\n');
