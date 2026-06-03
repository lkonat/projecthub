import { createServer } from 'node:http';
import { createApp } from './app.js';
import { config } from './config/index.js';
import { runMigrations } from './db/migrate.js';
import { loadExtensions } from './extensions/loader.js';
import { realtime } from './realtime/index.js';
import { projectDirTracker } from './tracker/projectDirTracker.js';
import { fileWatcher } from './watcher/fileWatcher.js';

runMigrations();
// Load user extensions BEFORE attaching the realtime bridge — that way
// user hooks fire first for each event and the wire broadcast sees the
// state user hooks already mutated.
await loadExtensions();

const app = createApp();
const httpServer = createServer(app);
realtime.start(httpServer);

const server = httpServer.listen(config.port, () => {
  console.log(`projecthub server running at http://localhost:${config.port}`);
});

async function shutdown(signal) {
  console.log(`\n${signal} received, shutting down...`);
  await projectDirTracker.stopAll();
  await fileWatcher.close();
  await realtime.close();
  server.close(() => process.exit(0));
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
