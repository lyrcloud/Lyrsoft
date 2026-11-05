// Bundles the parts of amazon-chime-sdk-js the meeting page uses (lyrsoft/meet.js) into one browser
// module, lyrsoft/chime-sdk.js, which is committed and served like the app's own files (no third-party
// CDN at runtime). Re-run after upgrading amazon-chime-sdk-js:
//
//   node scripts/build-chime-sdk.mjs
//
// ESBUILD_MODULE can point at esbuild-wasm where the native esbuild binary can't run.
import { writeFile } from 'node:fs/promises';

const esbuild = await import(process.env.ESBUILD_MODULE || 'esbuild');
const { version } = JSON.parse(await (await import('node:fs/promises')).readFile('node_modules/amazon-chime-sdk-js/package.json', 'utf8'));
const result = await (esbuild.default || esbuild).build({
  stdin: {
    // From the package's main entry: importing single files breaks the SDK's internal load order.
    contents: `export { ConsoleLogger, DefaultDeviceController, DefaultMeetingSession, LogLevel, MeetingSessionConfiguration } from 'amazon-chime-sdk-js';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  legalComments: 'none',
  write: false,
  define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
  // The SDK references its messaging client (Node-only, unused by meetings); bundle an empty stand-in.
  plugins: [{
    name: 'no-messaging',
    setup(build) {
      build.onResolve({ filter: /^@aws-sdk\/client-chime-sdk-messaging$/ }, () => ({ path: 'messaging-stub', namespace: 'stub' }));
      build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'module.exports = {};', loader: 'js' }));
    },
  }],
  logLevel: 'warning',
});
const banner = `// amazon-chime-sdk-js ${version} (Apache-2.0, https://github.com/aws/amazon-chime-sdk-js), bundled by scripts/build-chime-sdk.mjs.\n`;
await writeFile('lyrsoft/chime-sdk.js', banner + result.outputFiles[0].text);
console.log(`Wrote lyrsoft/chime-sdk.js (amazon-chime-sdk-js ${version}, ${Math.round(result.outputFiles[0].contents.length / 1024)} KB)`);
