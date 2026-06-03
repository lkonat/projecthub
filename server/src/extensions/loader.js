import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../config/index.js';
import { registry } from './registry.js';

// Layout (see extensions/README.md):
//
//   extensions/
//   ├── global/
//   │   ├── hooks/*.js      ← no type filter
//   │   └── buttons/*.js
//   ├── shared/             ← helper modules; loader ignores this
//   └── types/
//       └── <id>/
//           ├── type.js     ← type definition
//           ├── hooks/*.js  ← `type: '<id>'` is INFERRED from this path
//           └── buttons/*.js
//
// The loader infers `type: '<id>'` for files under `types/<id>/{hooks,buttons}/`.
// Files may still declare `type:` explicitly — if it disagrees with the
// inferred value we warn and trust the path.

async function importDefault(filePath) {
  const mod = await import(pathToFileURL(filePath).href);
  return mod.default ?? mod;
}

function isJsFile(name) {
  return name.endsWith('.js') || name.endsWith('.mjs');
}

function listJsFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(isJsFile).sort().map((f) => path.join(dir, f));
}

function withInferredType(def, sourcePath, inferredType) {
  if (!inferredType) return def;
  if (def.type && def.type !== inferredType) {
    console.warn(
      `[extensions] ${sourcePath} declares type '${def.type}' but lives under ` +
      `types/${inferredType}/ — using '${inferredType}'.`
    );
  }
  return { ...def, type: inferredType };
}

function shortPath(extRoot, full) {
  return path.relative(extRoot, full);
}

async function loadHook(file, extRoot, inferredType) {
  const src = shortPath(extRoot, file);
  try {
    const def = await importDefault(file);
    registry.registerHook(withInferredType(def, src, inferredType), src);
    return true;
  } catch (err) {
    console.error(`[extensions] hook ${src} failed: ${err.message}`);
    return false;
  }
}

async function loadButton(file, extRoot, inferredType) {
  const src = shortPath(extRoot, file);
  try {
    const def = await importDefault(file);
    registry.registerButton(withInferredType(def, src, inferredType), src);
    return true;
  } catch (err) {
    console.error(`[extensions] button ${src} failed: ${err.message}`);
    return false;
  }
}

async function loadType(file, extRoot, expectedId) {
  const src = shortPath(extRoot, file);
  try {
    const def = await importDefault(file);
    if (expectedId && def.id && def.id !== expectedId) {
      console.warn(
        `[extensions] ${src} has id '${def.id}' but lives under ` +
        `types/${expectedId}/ — using '${expectedId}'.`
      );
    }
    registry.registerType({ ...def, id: expectedId || def.id }, src);
    return true;
  } catch (err) {
    console.error(`[extensions] type ${src} failed: ${err.message}`);
    return false;
  }
}

export async function loadExtensions() {
  const root = config.extensionsDir;
  if (!fs.existsSync(root)) {
    console.log(`[extensions] no directory at ${root} — skipping`);
    return;
  }

  let typeCount = 0, hookCount = 0, buttonCount = 0;

  // 1) Types and their scoped hooks/buttons.
  const typesDir = path.join(root, 'types');
  if (fs.existsSync(typesDir)) {
    const typeIds = fs
      .readdirSync(typesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

    for (const id of typeIds) {
      const typeDir = path.join(typesDir, id);
      const typeFile = path.join(typeDir, 'type.js');
      if (!fs.existsSync(typeFile)) {
        console.warn(`[extensions] types/${id}/ has no type.js — skipping`);
        continue;
      }
      if (await loadType(typeFile, root, id)) typeCount++;

      for (const f of listJsFiles(path.join(typeDir, 'hooks'))) {
        if (await loadHook(f, root, id)) hookCount++;
      }
      for (const f of listJsFiles(path.join(typeDir, 'buttons'))) {
        if (await loadButton(f, root, id)) buttonCount++;
      }
    }
  }

  // 2) Global hooks and buttons (no inferred type).
  for (const f of listJsFiles(path.join(root, 'global', 'hooks'))) {
    if (await loadHook(f, root, null)) hookCount++;
  }
  for (const f of listJsFiles(path.join(root, 'global', 'buttons'))) {
    if (await loadButton(f, root, null)) buttonCount++;
  }

  // 3) `shared/` is intentionally ignored — those are helpers, not extensions.

  console.log(
    `[extensions] loaded ${typeCount} type(s), ${hookCount} hook(s), ` +
    `${buttonCount} button(s) from ${root}`
  );
}
