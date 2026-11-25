# droid64 — Breadbin 64

Emulatore Commodore 64 (PAL) scritto in TypeScript che gira nel browser.

## Cosa emula
- **CPU 6510**: tutti gli opcode, compresi quelli non documentati; supera la suite di test di Klaus Dormann
- **VIC-II**: modalità testo, multicolore, ECM, bitmap, 8 sprite con collisioni, interrupt raster, apertura dei bordi superiore e inferiore (rendering per riga)
- **SID**: 3 voci, forme d'onda, ADSR, filtro, ring modulation e sync
- **2× CIA 6526**: timer, TOD, tastiera, joystick, interrupt
- **Comandi touch**: joystick a schermo (8 direzioni, multitocco con il pulsante di fuoco) e tasti Spazio, Return, Run/Stop, F1–F7, Y, N; si attiva da solo sui telefoni
- **Schermo intero da telefono**: emulatore in alto e sotto la tastiera del C64 (SHIFT, C= e CTRL valgono per il tasto successivo, SHIFT LOCK resta attivo) oppure il joystick; funziona anche su iPhone. Da computer lo schermo intero mostra solo lo schermo del C64, il più grande possibile
- **Drive 8**: LED verde con disco inserito e LED rosso a ogni accesso; pulsanti per vedere la directory (`LOAD"$",8` + `LIST`) e per caricare e avviare il primo programma (`LOAD"*",8,1` + `RUN` o `SYS`)
- **Cartucce .CRT**: normali 8K/16K/Ultimax, Ocean, EasyFlash, Magic Desk, System 3, Dinamic, Fun Play, Super Games, Simons' BASIC, Epyx FastLoad (logica PLA completa con EXROM/GAME)
- **Drive virtuale 1541 (device 8)**: risponde alle routine del bus seriale del KERNAL, quindi funzionano `LOAD`, `OPEN`/`GET#`/`INPUT#`/`PRINT#`, il canale comandi 15 (stato, `I`, `UI`, `M-R`, `M-W`), la lettura diretta dei settori (`U1`, `B-R`, `B-P`) e la directory `$`. Con le Open ROMs funziona solo `LOAD`
- **Caricamento**: PRG, D64 e T64

## ROM
Di base usa le ROM libere [MEGA65 Open ROMs](https://github.com/MEGA65/open-roms) (LGPL-3.0), incluse in `src/roms.ts`. Il loro BASIC è incompleto: per il BASIC V2 completo carica dall'interfaccia le ROM originali (basic, kernal, chargen), che restano salvate solo nel browser. Le ROM originali **non** sono incluse in questo repository.

## Uso
Versione online: https://mokkus68.github.io/droid64/

Apri `docs/index.html` in un browser: è una pagina unica, autonoma.

Per ricompilare (il risultato va in `docs/`, la cartella pubblicata da GitHub Pages):

```bash
npm install
npm run build
```

## Struttura
| File | Contenuto |
|---|---|
| `src/cpu.ts` | CPU 6510 |
| `src/vic.ts` | VIC-II e palette |
| `src/sid.ts` | SID |
| `src/cia.ts` | CIA 6526 |
| `src/c64.ts` | mappa di memoria, collegamento dei chip, loop del frame, caricamento |
| `src/media.ts` | lettura di D64/T64 |
| `src/vdrive.ts` | drive virtuale 1541 sul bus seriale |
| `src/cartridge.ts` | cartucce .CRT e cambio di banco |
| `src/keyboard.ts` | mappatura tastiera PC → matrice C64 |
| `src/vkbd.ts` | tastiera C64 a schermo |
| `src/main.ts` | interfaccia, audio, input |
| `index.template.html` | pagina e stili; `build.mjs` ci inserisce il bundle |
| `test/` | test headless con Node (CPU, avvio, BASIC, sprite, dischi) |

## Test
Il test della CPU usa il binario della suite di Klaus Dormann:

```bash
mkdir -p testdata && curl -sSfL -o testdata/6502_functional_test.bin https://raw.githubusercontent.com/Klaus2m5/6502_65C02_functional_tests/master/bin_files/6502_functional_test.bin
npx esbuild test/cputest.ts --bundle --platform=node --outfile=/tmp/cputest.js && node /tmp/cputest.js testdata/6502_functional_test.bin
```

I test che usano le ROM originali leggono la cartella indicata dalla variabile `ORIG`.

## Limiti noti
- Temporizzazione per istruzione e rendering per riga: niente trucchi al singolo ciclo (bordi laterali, FLI)
- Il drive è virtuale, non un 1541 emulato: i fastloader che caricano codice proprio nel drive (`M-E`) non funzionano; quando un programma ci prova compare un avviso
- Cartucce `.CRT`: non sono supportati i tipi con freezer o hardware speciale (Action Replay, Final Cartridge III, Retro Replay…)

## Licenza
Il codice dell'emulatore è distribuito con licenza [MIT](LICENSE).
Le Open ROMs incluse in `src/roms.ts` (e quindi in `docs/index.html`) restano sotto la propria licenza LGPL-3.0.
