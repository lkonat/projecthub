import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..', '..');
const projectRoot = path.resolve(serverRoot, '..');

export const config = {
  port: Number(process.env.PORT) || 3005,
  dbPath: path.resolve(serverRoot, process.env.DB_PATH || './data/projecthub.db'),
  clientOrigins: (process.env.CLIENT_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  serverRoot,
  projectRoot,
  extensionsDir: process.env.EXTENSIONS_DIR
    ? path.resolve(projectRoot, process.env.EXTENSIONS_DIR)
    : path.join(projectRoot, 'extensions'),
};
