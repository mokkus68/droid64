# droid64

Emulatore Commodore 64 (PAL) scritto in TypeScript che gira nel browser.

## Cosa emula
- **CPU 6510**: tutti gli opcode, compresi quelli non documentati; supera la suite di test di Klaus Dormann
- **VIC-II**: modalità testo, multicolore, ECM, bitmap, 8 sprite con collisioni, interrupt raster, apertura dei bordi superiore e inferiore (rendering per riga)
- **SID**: 3 voci, forme d'onda, ADSR, filtro, ring modulation e sync
- **2× CIA 6526**: timer, TOD, tastiera, joystick, interrupt
- **Comandi touch**: joystick a schermo (8 direzioni, multitocco con il pulsante di fuoco) e tasti Spazio, Return, Run/Stop, F1–F7, Y, N; si attiva da solo sui telefoni
- **Schermo intero da telefono**: emulatore in alto e sotto la tastiera del C64 (SHIFT, C= e CTRL valgono per il tasto successivo, SHIFT LOCK resta attivo) oppure il joystick; funziona anche su iPhone. Da computer lo schermo intero mostra solo lo schermo del C64, il più grande possibile
- **Drive 8**: LED verde con disco inserito e LED rosso a ogni accesso; pulsanti per vedere la directory (`LOAD"$",8` + `LIST`) e per caricare e avviare il primo programma (`LOAD"*",8,1` + `RUN` o `SYS`)
- **Cartucce .CRT**: normali 8K/16K/Ultimax, freezer Action Replay (32 KB ROM + 8 KB RAM) e Final Cartridge III (64 KB) con pulsante Freeze, Ocean, EasyFlash, Magic Desk, System 3, Dinamic, Fun Play, Super Games, Simons' BASIC, Epyx FastLoad (logica PLA completa con EXROM/GAME)
- **1541 emulato** (con la ROM del drive caricata dall'utente): processore 6502 del drive, 2 KB di RAM, due VIA 6522, motore e testina con mezze tracce, lettura e scrittura bit per bit (sincronismo da 10 bit a 1, byte pronto ogni 8 bit) alla velocità della zona, bus seriale ATN/CLK/DATA. C64 e drive avanzano insieme con precisione al ciclo, quindi funzionano anche i fastloader. Turbo automatico mentre il drive gira
- **Drive virtuale veloce (device 8)**, in alternativa: risponde alle routine del bus seriale del KERNAL, quindi funzionano `LOAD`, `OPEN`/`GET#`/`INPUT#`/`PRINT#`, il canale comandi 15 (stato, `I`, `UI`, `M-R`, `M-W`), la lettura diretta dei settori (`U1`, `B-R`, `B-P`) e la directory `$`. Con le Open ROMs funziona solo `LOAD`
- **Scrittura su disco** con entrambi i drive: `SAVE` (anche `@0:` per sostituire), file `SEQ`/`PRG` aperti in scrittura, cancellazione `S:`, rinomina `R:`, formattazione `N:`. Con il 1541 emulato scrive il DOS del drive in GCR e i settori vengono ridecodificati nell'immagine D64. I dischi modificati restano salvati nel browser, si possono scaricare come `.d64` e si possono creare dischi vuoti
- **Nastri .TAP** (v0 e v1): registratore emulato a livello di impulsi sul pin FLAG del CIA1, con tasto PLAY e motore sulla porta `$01`, quindi funzionano sia il caricamento del KERNAL sia i turbo loader. Avvio automatico, turbo mentre il motore gira (disattivabile nel pannello del registratore per avere la velocità reale), contagiri del Datasette (non lineare come la bobina vera) con tasto di azzeramento. Salvataggio su nastro: con RECORD premuto gli impulsi che il C64 scrive (bit 3 di `$01`) vengono registrati in formato TAP, scaricabili e salvati nel browser
- **Mouse 1351 e paddle** su entrambe le porte: letti dal SID (`POTX`/`POTY`) con la selezione della porta dal CIA1; il mouse del browser viene catturato sullo schermo (Pointer Lock)
- **REU** 1700 (128 KB), 1764 (256 KB) e 1750 (512 KB): registri a `$DF00`, trasferimenti stash, fetch, swap e verify, autoload, indirizzi fissi, interrupt e avvio con scrittura su `$FF00`
- **Secondo drive (device 9)**, virtuale o 1541 emulato: i due 1541 emulati condividono il bus seriale come due drive veri in catena (numero di dispositivo dai ponticelli PB5-6 della VIA)
- **Dischi G64**: superficie GCR completa con mezze tracce e sincronismi non allineati ai byte, quindi le protezioni anticopia che il D64 perde; letti e scritti dal 1541 emulato e scaricabili come `.g64`
- **Dischi D71 (1571) e D81 (1581)** con il drive virtuale: lettura, directory, salvataggio, cancellazione, rinomina e formattazione, dischi vuoti
- **App installabile (PWA)**: manifest, icone e service worker con cache per versione; funziona offline e segnala gli aggiornamenti
- **Schermata e registrazione audio**: immagine PNG dello schermo (768×544) e registrazione del SID in WAV, presa direttamente dall'emulazione (anche in turbo o senza audio)
- **Snapshot**: stato completo della macchina (CPU, memoria, VIC, SID, CIA, REU, cartuccia, 1541 emulati con testina e memoria, dischi, nastro e configurazione) salvato nel database del browser, scaricabile e riapribile da file; il ripristino controlla che le ROM siano le stesse
- **Caricamento**: PRG, D64, D71, D81, T64 e TAP

## ROM
Di base usa le ROM libere [MEGA65 Open ROMs](https://github.com/MEGA65/open-roms) (LGPL-3.0), incluse in `src/roms.ts`. Il loro BASIC è incompleto: per il BASIC V2 completo carica dall'interfaccia le ROM originali (basic, kernal, chargen), che restano salvate solo nel browser. Le ROM originali **non** sono incluse in questo repository. Per il 1541 emulato serve anche la ROM del drive (16 KB, per esempio `dos1541-325302-01+901229-05.bin` nella cartella `DRIVES` di VICE).

## Uso
Versione online: https://mokkus68.github.io/droid64/ — si può installare come app (PWA) e funziona anche senza connessione.

Apri `docs/index.html` in un browser: è una pagina unica, autonoma.

Per ricompilare (il risultato va in `docs/`, la cartella pubblicata da GitHub Pages):

```bash
npm install
npm run build
```

## Versione
La versione (`version` in `package.json`) e la data di compilazione compaiono in alto a destra nella pagina e nel piè di pagina: la build le inserisce in automatico.

## Struttura
| File | Contenuto |
|---|---|
| `src/cpu.ts` | CPU 6510 |
| `src/vic.ts` | VIC-II e palette |
| `src/sid.ts` | SID |
| `src/cia.ts` | CIA 6526 |
| `src/c64.ts` | mappa di memoria, collegamento dei chip, loop del frame, caricamento |
| `src/media.ts` | lettura di D64/T64 |
| `src/vdrive.ts` | drive virtuale veloce sul bus seriale del KERNAL |
| `src/drive1541.ts` | 1541 emulato: CPU, memoria, meccanica, bus seriale |
| `src/via.ts` | VIA 6522 |
| `src/gcr.ts` | codifica GCR, decodifica a livello di bit, formato G64 |
| `src/geometry.ts` | geometrie D64, D71 e D81 (tracce, settori, BAM) |
| `src/d64write.ts` | scrittura su D64: BAM, directory, cancellazione, rinomina, formattazione |
| `src/snapshot.ts` | cattura e ripristino dello stato, archivio IndexedDB |
| `src/reu.ts` | espansione di memoria REU |
| `src/tape.ts` | registratore (Datasette) da file .TAP |
| `src/cartridge.ts` | cartucce .CRT e cambio di banco |
| `src/keyboard.ts` | mappatura tastiera PC → matrice C64 |
| `src/vkbd.ts` | tastiera C64 a schermo |
| `src/main.ts` | interfaccia, audio, input |
| `pwa/` | manifest, service worker e icone dell'app installabile (copiati in `docs/` dalla build) |
| `index.template.html` | pagina e stili; `build.mjs` ci inserisce il bundle |
| `test/` | test headless con Node (CPU, avvio, BASIC, sprite, dischi) |

## Test
Il test della CPU usa il binario della suite di Klaus Dormann:

```bash
mkdir -p testdata && curl -sSfL -o testdata/6502_functional_test.bin https://raw.githubusercontent.com/Klaus2m5/6502_65C02_functional_tests/master/bin_files/6502_functional_test.bin
npx esbuild test/cputest.ts --bundle --platform=node --outfile=/tmp/cputest.js && node /tmp/cputest.js testdata/6502_functional_test.bin
```

I test che usano le ROM originali leggono la cartella indicata dalla variabile `ORIG`; quelli del 1541 emulato (`test/drive.ts`, `test/fastxfer.ts`) leggono la ROM del drive dalla variabile `DRIVEROM`.

## Limiti noti
- Temporizzazione per istruzione e rendering per riga: niente trucchi al singolo ciclo (bordi laterali, FLI)
- Con il drive virtuale i fastloader non funzionano (compare un avviso): serve il 1541 emulato
- Il 1541 emulato non riproduce i bit deboli o le variazioni di velocità all'interno di una traccia (G64 con tabelle di velocità per byte)
- I file `.T64` sono di sola lettura; con le Open ROMs il salvataggio su nastro non funziona (il loro KERNAL non lo implementa)
- Cartucce `.CRT`: non sono supportati gli altri tipi con hardware speciale (Retro Replay, Expert, Atomic Power…)

## Licenza
Il codice dell'emulatore è distribuito con licenza [MIT](LICENSE).
Le Open ROMs incluse in `src/roms.ts` (e quindi in `docs/index.html`) restano sotto la propria licenza LGPL-3.0.
