# droid64 — istruzioni per il progetto

Emulatore Commodore 64 in TypeScript per il browser. Il sito è pubblicato con GitHub Pages dalla cartella `docs/` del branch `main`: https://mokkus68.github.io/droid64/

## Versione: aumentala a ogni modifica rilasciata

La versione è `version` in `package.json`. `npm run build` la scrive nella pagina (intestazione e piè di pagina) insieme alla data di compilazione.

Ogni volta che una modifica viene pubblicata su `main`, aumenta la versione **prima** della build, secondo il versionamento semantico:

- **nuova funzione** (per esempio un nuovo formato di file, un nuovo comando, un nuovo pannello): versione minore, `1.0.0` → `1.1.0`
  ```bash
  npm version minor --no-git-tag-version
  ```
- **correzione di un errore** o ritocco senza nuove funzioni: patch, `1.1.0` → `1.1.1`
  ```bash
  npm version patch --no-git-tag-version
  ```
- **cambiamento incompatibile** (per esempio dischi o impostazioni salvati nel browser che non si possono più leggere): versione maggiore, solo dopo averlo chiesto all'utente.

Le modifiche che non toccano la pagina (solo test, README, questo file) non cambiano la versione.

Indica la nuova versione nel messaggio di commit e nella risposta all'utente.

## Build e verifica

```bash
npm ci
npm run typecheck
npm run build
```

`npm run build` aggiorna `docs/` (pagina, `manifest.webmanifest`, `sw.js` con la cache intestata alla versione, icone) e `dist/artifact.html` (copia per l'anteprima, non versionata). Committa sempre anche `docs/`, altrimenti il sito non cambia. Il nome della cache del service worker deriva dalla versione: per questo la versione va aumentata a ogni rilascio, altrimenti gli utenti dell'app installata non ricevono l'aggiornamento.

I test sono script in `test/` da compilare con esbuild ed eseguire con Node; vedi il README. Quelli con le ROM originali o la ROM del 1541 leggono i percorsi dalle variabili `ORIG` e `DRIVEROM`: le ROM non sono nel repository e non vanno mai aggiunte, perché sono coperte da copyright.

## Lingua

L'interfaccia, il README e i messaggi di commit sono in italiano.
