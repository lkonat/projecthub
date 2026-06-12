import { createServer } from 'node:http';
import { createApp } from './app.js';
import { config } from './config/index.js';
import { runMigrations } from './db/migrate.js';
import { loadExtensions } from './extensions/loader.js';
import { agentsService } from './modules/agents/agents.service.js';
import { agentRunner } from './ai/runner/index.js';
import { queue } from './queue/index.js';
import { realtime } from './realtime/index.js';
import { projectDirTracker } from './tracker/projectDirTracker.js';
import { fileWatcher } from './watcher/fileWatcher.js';

runMigrations();
// Load user extensions BEFORE attaching the realtime bridge — that way
// user hooks fire first for each event and the wire broadcast sees the
// state user hooks already mutated.
await loadExtensions();
// Register the code agents (now in the in-memory registry) into the database,
// so they're first-class, assignable entities. Runs AFTER loadExtensions —
// agents must be registered in memory before we can sync them to the table.
agentsService.syncFromRegistry();
// Wire the agent runner to the job queue, then start the queue: it recovers any
// jobs interrupted by a prior crash and begins processing within the concurrency
// cap. The queue is generic; the runner is its first consumer.
agentRunner.init();
queue.start();

const app = createApp();
const httpServer = createServer(app);
realtime.start(httpServer);

const server = httpServer.listen(config.port, () => {
  console.log(`projecthub server running at http://localhost:${config.port}`);
});

async function shutdown(signal) {
  console.log(`\n${signal} received, shutting down...`);
  queue.stop(); // stop claiming new jobs; in-flight ones settle
  await projectDirTracker.stopAll();
  await fileWatcher.close();
  await realtime.close();
  server.close(() => process.exit(0));
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
