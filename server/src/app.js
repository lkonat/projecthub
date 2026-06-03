import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config/index.js';
import apiRouter from './routes/index.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(__dirname, '..', '..', 'client');

export function createApp() {
  const app = express();

  app.use(express.json({ limit: '1mb' }));
  app.use(
    cors({
      origin(origin, cb) {
        if (!origin) return cb(null, true);
        if (config.clientOrigins.length === 0) return cb(null, true);
        if (config.clientOrigins.includes(origin)) return cb(null, true);
        cb(new Error(`Origin ${origin} not allowed`));
      },
      credentials: true,
    })
  );

  app.use('/api', apiRouter);

  // Unknown API routes get a JSON 404 (before the SPA fallback below, so
  // they never fall through to index.html).
  app.use('/api', notFoundHandler);

  // Serve the default view (one of many possible interfaces)
  app.use('/', express.static(clientDir));

  // SPA fallback: any non-API GET that didn't match a static file serves
  // index.html, so client-side routes like /projects/3 deep-link correctly.
  app.get('*', (req, res) => {
    res.sendFile(path.join(clientDir, 'index.html'));
  });

  app.use(errorHandler);

  return app;
}
