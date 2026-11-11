// Builds lyrsoft.com (lyrsoft/) into dist-lyrsoft/: the company website at /, the Lyrsoft Work app at /app/
// and Lyr Chat at /chat/ (its service worker, lyrchat-sw.js, is served unhashed as /chat/sw.js).
// Assets go under /assets/<content hash>/ so they can be cached forever.
// The Cognito helpers (src/auth.js, src/cognito.js) are copied alongside, and config.js carries the API URL
// from LYRSOFT_API_BASE (set by scripts/deploy-lyrsoft.sh from the lyrsoft-work-api stack) and the optional
// LYRSOFT_GOOGLE_CLIENT_ID for importing from Google Contacts.
import { createHash } from 'node:crypto';
import { copyFile, cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const OUT = 'dist-lyrsoft';
const apiBase = (process.env.LYRSOFT_API_BASE || 'http://localhost:8787').replace(/\/$/, '');

const files = new Map();
for (const name of await readdir('lyrsoft')) {
  if (/\.(js|css)$/.test(name)) files.set(name, await readFile(join('lyrsoft', name)));
}
files.set('auth.js', await readFile('src/auth.js'));
files.set('cognito.js', await readFile('src/cognito.js'));
// LYRSOFT_GOOGLE_CLIENT_ID: a Google OAuth web client (People API, lyrsoft.com as a JavaScript origin)
// that lets Contacts import straight from Google; without it the app explains Google's own export.
const googleClientId = process.env.LYRSOFT_GOOGLE_CLIENT_ID || '';
files.set('config.js', Buffer.from(`export const WORK_API_BASE = ${JSON.stringify(apiBase)};\nexport const GOOGLE_CLIENT_ID = ${JSON.stringify(googleClientId)};\n`));

const hash = createHash('sha256');
for (const [name, body] of [...files].sort(([a], [b]) => a.localeCompare(b))) hash.update(name).update(body);
const assetBase = `/assets/${hash.digest('hex').slice(0, 12)}/`;

await rm(OUT, { recursive: true, force: true });
await mkdir(join(OUT, assetBase), { recursive: true });
for (const [name, body] of files) await writeFile(join(OUT, assetBase, name), body);
// The company website is the home page; the app lives at /app/. /callback.html stays at the root
// because it is the redirect URL registered with Cognito.
const pages = { 'home.html': 'index.html', 'index.html': 'app/index.html', 'lyrchat.html': 'chat/index.html', 'callback.html': 'callback.html', '404.html': '404.html' };
await mkdir(join(OUT, 'app'), { recursive: true });
await mkdir(join(OUT, 'chat'), { recursive: true });
// A service worker's scope is its folder, so it can't live under /assets/.
await copyFile(join('lyrsoft', 'lyrchat-sw.js'), join(OUT, 'chat', 'sw.js'));
// Lyrbot's Lyr Chat button for other sites, at a stable URL they can embed.
await copyFile(join('lyrsoft', 'lyrchat-widget.js'), join(OUT, 'lyrchat-widget.js'));
for (const [source, target] of Object.entries(pages)) {
  let html = await readFile(join('lyrsoft', source), 'utf8');
  // Pages reference assets as "/app/<file>"; links to the app itself ("/app/") are left alone.
  for (const name of files.keys()) html = html.replaceAll(`"/app/${name}"`, `"${assetBase}${name}"`);
  await writeFile(join(OUT, target), html);
}


// Logo, favicons and web manifest (lyrsoft/brand/) are served from /brand/, with /favicon.ico at the root.
await cp(join('lyrsoft', 'brand'), join(OUT, 'brand'), { recursive: true });
await copyFile(join('lyrsoft', 'brand', 'favicon.ico'), join(OUT, 'favicon.ico'));
// Search engines: crawl rules and the list of public pages.
await copyFile(join('lyrsoft', 'robots.txt'), join(OUT, 'robots.txt'));
await copyFile(join('lyrsoft', 'sitemap.xml'), join(OUT, 'sitemap.xml'));

console.log(`Built Lyrsoft into ${OUT}/ (assets at ${assetBase}, API ${apiBase})`);
