// Per-type settings loader.
//
// Every project type can carry its own `.env` file in its type directory
// (e.g. extensions/types/othot-swe-work/.env). This helper reads that file
// and hands back a small, frozen accessor that the type's buttons and hooks
// import — a single source of truth instead of values hardcoded across files.
//
// It is a `shared/` helper, so the extension loader ignores it; you pull it
// in explicitly. It depends only on Node built-ins (no `dotenv`) because the
// extensions tree has no reachable node_modules.
//
// Precedence for a given key:
//   1. the type's own .env file  (the specific, committed config wins)
//   2. process.env               (fallback / operator override for unset keys)
//   3. the caller's default

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Minimal .env parser: `KEY=VALUE` per line. Supports `#` comments, blank
// lines, surrounding single/double quotes, and a leading `export `. Anything
// it can't make sense of is skipped rather than throwing — a malformed line
// shouldn't take the whole server down at boot.
export function parseEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq === -1) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (!key) continue;

    let value = withoutExport.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted) {
      value = value.slice(1, -1);
    } else {
      // For unquoted values, drop an inline trailing comment.
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off', '']);

// Pass `import.meta.url` of a type's `settings/settings.js`. The .env is
// resolved from the parent (the type directory itself).
export function createSettings(settingsModuleUrl) {
  const settingsDir = path.dirname(fileURLToPath(settingsModuleUrl));
  const typeDir = path.resolve(settingsDir, '..');
  const typeId = path.basename(typeDir);
  const envPath = path.join(typeDir, '.env');

  let fileEnv = {};
  let loaded = false;
  if (fs.existsSync(envPath)) {
    try {
      fileEnv = parseEnv(fs.readFileSync(envPath, 'utf8'));
      loaded = true;
    } catch (err) {
      console.error(`[settings:${typeId}] failed to read ${envPath}: ${err.message}`);
    }
  }

  function raw(key) {
    if (Object.prototype.hasOwnProperty.call(fileEnv, key)) return fileEnv[key];
    if (process.env[key] !== undefined) return process.env[key];
    return undefined;
  }

  function get(key, fallback = undefined) {
    const v = raw(key);
    return v === undefined ? fallback : v;
  }

  function requireKey(key) {
    const v = raw(key);
    if (v === undefined || v === '') {
      throw new Error(
        `[settings:${typeId}] missing required key '${key}'. ` +
        `Set it in ${path.relative(process.cwd(), envPath)} (or the environment).`
      );
    }
    return v;
  }

  function bool(key, fallback = false) {
    const v = raw(key);
    if (v === undefined) return fallback;
    const low = String(v).trim().toLowerCase();
    if (TRUTHY.has(low)) return true;
    if (FALSY.has(low)) return false;
    return fallback;
  }

  function int(key, fallback = undefined) {
    const v = raw(key);
    if (v === undefined) return fallback;
    const n = Number.parseInt(v, 10);
    return Number.isNaN(n) ? fallback : n;
  }

  // `values` is a plain snapshot of every resolved key (file ∪ process.env),
  // handy for spreading/logging. Frozen so consumers can't mutate the hub.
  const values = Object.freeze({ ...process.env, ...fileEnv });

  return Object.freeze({
    typeId,
    envPath,
    loaded,
    values,
    get,
    require: requireKey,
    bool,
    int,
  });
}
