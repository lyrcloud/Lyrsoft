import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

// Serves dist-lyrsoft/ (scripts/build-lyrsoft.mjs) for local development.
const root = join(process.cwd(), 'dist-lyrsoft');
const buildScript = 'scripts/build-lyrsoft.mjs';
const port = Number(process.env.PORT || 5174);
const types = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);

// Rebuild on every page request so edits to lyrsoft/ and src/ show up on refresh.
const build = () => execFileSync(process.execPath, [buildScript], { stdio: 'ignore' });
build();

// Mirrors the CloudFront viewer-request rewrite in infra/aws/lyrsoft-site.yml.
const resolve = (pathname) => {
  if (pathname.endsWith('/')) return `${pathname}index.html`;
  return extname(pathname) ? pathname : `${pathname}/index.html`;
};

createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host}`);
  const normalizedPath = normalize(resolve(decodeURIComponent(url.pathname))).replace(/^([/\\])+/, '');
  if (normalizedPath.startsWith('..')) {
    response.writeHead(400).end();
    return;
  }
  const filePath = join(root, normalizedPath);
  if (filePath.endsWith('.html')) {
    try { build(); } catch (error) { console.error(error.message); }
  }
  try {
    const body = await readFile(filePath);
    response.writeHead(200, { 'content-type': types.get(extname(filePath)) || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    response.end(await readFile(join(root, '404.html')).catch(() => 'Not found'));
  }
}).listen(port, '0.0.0.0', () => {
  console.log(`Lyrsoft dev server running at http://localhost:${port}`);
});
