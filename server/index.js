import { config } from './config.js';
import { createApp } from './app.js';
import { bootstrap } from './bootstrap.js';
import { startWorker, stopWorker } from './mail/queue.js';

bootstrap();
startWorker();

const server = createApp().listen(config.port, () => {
  console.log(`Lyrsoft running at ${config.baseUrl}  ·  Hub: ${config.baseUrl}/hub/`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopWorker();
    server.close(() => process.exit(0));
  });
}
