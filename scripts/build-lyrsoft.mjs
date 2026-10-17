// Builds lyrsoft.com (lyrsoft/) into dist-lyrsoft/: the company website at / and the Lyrsoft Work app at /app/.
// Assets go under /assets/<content hash>/ so they can be cached forever.
// The Cognito helpers (src/auth.js) are copied alongside, and config.js carries the API URL
// from LYRSOFT_API_BASE (set by scripts/deploy-lyrsoft.sh from the lyrsoft-work-api stack).
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const OUT = 'dist-lyrsoft';
const apiBase = (process.env.LYRSOFT_API_BASE || 'http://localhost:8787').replace(/\/$/, '');

const files = new Map();
for (const name of await readdir('lyrsoft')) {
  if (/\.(js|css)$/.test(name)) files.set(name, await readFile(join('lyrsoft', name)));
}
files.set('auth.js', await readFile('src/auth.js'));
files.set('config.js', Buffer.from(`export const WORK_API_BASE = ${JSON.stringify(apiBase)};\n`));

const hash = createHash('sha256');
for (const [name, body] of [...files].sort(([a], [b]) => a.localeCompare(b))) hash.update(name).update(body);
const assetBase = `/assets/${hash.digest('hex').slice(0, 12)}/`;

await rm(OUT, { recursive: true, force: true });
await mkdir(join(OUT, assetBase), { recursive: true });
for (const [name, body] of files) await writeFile(join(OUT, assetBase, name), body);
// The company website is the home page; the app lives at /app/. /callback.html stays at the root
// because it is the redirect URL registered with Cognito.
const pages = { 'home.html': 'index.html', 'index.html': 'app/index.html', 'callback.html': 'callback.html', '404.html': '404.html' };
await mkdir(join(OUT, 'app'), { recursive: true });
for (const [source, target] of Object.entries(pages)) {
  let html = await readFile(join('lyrsoft', source), 'utf8');
  // Pages reference assets as "/app/<file>"; links to the app itself ("/app/") are left alone.
  for (const name of files.keys()) html = html.replaceAll(`"/app/${name}"`, `"${assetBase}${name}"`);
  await writeFile(join(OUT, target), html);
}

console.log(`Built Lyrsoft into ${OUT}/ (assets at ${assetBase}, API ${apiBase})`);
