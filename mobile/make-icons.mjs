// Renders the app icon and splash artwork (assets/*.png) for `npm run icons`: a white chat bubble on
// Lyrsoft's purple, matching lyrsoft.com/chat/.
import sharp from 'sharp';

const bubble = `
  <path d="M32 12c-11.6 0-21 8.1-21 18.2 0 5.4 2.7 10.3 7 13.6l-1.6 7.7c-.2 1 .8 1.8 1.7 1.3l8.3-4.4c1.8.4 3.7.6 5.6.6 11.6 0 21-8.1 21-18.2S43.6 12 32 12z" fill="#fff"/>
  <circle cx="23" cy="30.5" r="2.8" fill="#6247ea"/><circle cx="32" cy="30.5" r="2.8" fill="#6247ea"/><circle cx="41" cy="30.5" r="2.8" fill="#6247ea"/>`;
const grad = '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6247ea"/><stop offset="1" stop-color="#a855f7"/></linearGradient></defs>';
const svg = (body, viewBox = '0 0 64 64') => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${grad}${body}</svg>`);

await sharp(svg(`<rect width="64" height="64" fill="url(#g)"/>${bubble}`)).resize(1024, 1024).png().toFile('assets/icon-only.png');
await sharp(svg(bubble, '-16 -16 96 96')).resize(1024, 1024).png().toFile('assets/icon-foreground.png');
await sharp(svg('<rect width="64" height="64" fill="url(#g)"/>')).resize(1024, 1024).png().toFile('assets/icon-background.png');
await sharp(svg(`<rect width="2732" height="2732" fill="#fff"/><g transform="translate(1110 1110) scale(8)"><rect width="64" height="64" rx="14" fill="url(#g)"/>${bubble}</g>`, '0 0 2732 2732'))
  .resize(2732, 2732).png().toFile('assets/splash.png');
console.log('icons written');
