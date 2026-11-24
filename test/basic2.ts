import { makeC64, makeOrigC64, screenText } from './util';
const c = (process.env.ORIG ? makeOrigC64() : makeC64());
for (let i = 0; i < 150; i++) c.runFrame();
c.typeText('PRINT 2*3\nPRINT 7/2\nPRINT "A";"B"\nFOR I=1 TO 3:PRINT I:NEXT\nX=5:PRINT X+1\nPOKE 53280,2:PRINT PEEK(53280)\nPRINT SIN(1)\n');
for (let i = 0; i < 300; i++) c.runFrame();
console.log(screenText(c));
