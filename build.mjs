import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
const r = await build({ entryPoints: ['src/main.ts'], bundle: true, minify: true, format: 'iife', target: 'es2020', write: false });
const js = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
// build date shown on the page, in Italian time
const built = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const body = readFileSync('index.template.html', 'utf8')
  .replace('/*BUNDLE*/', () => js)
  .replaceAll('{{VERSION}}', version)
  .replaceAll('{{BUILT}}', built);
// GitHub Pages needs a complete document (charset + mobile viewport)
const html = `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#1b1815">
</head>
<body>
${body}
</body>
</html>
`;
mkdirSync('docs', { recursive: true });
writeFileSync('docs/index.html', html);
// body-only copy for hosts that add their own document skeleton
mkdirSync('dist', { recursive: true });
writeFileSync('dist/artifact.html', body);
console.log('docs/index.html', (html.length / 1024).toFixed(1), 'KB', '· versione', version, '·', built);
