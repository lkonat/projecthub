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

// Failures collected during a load pass, so they can be summarized loudly at
// the end — a single error line mid-boot is easy to scroll past, and a failed
// button/hook otherwise silently just "doesn't show up".
let loadFailures = [];
function fail(kind, src, message) {
  loadFailures.push({ kind, src, message });
  console.error(`[extensions] ${kind} ${src} failed: ${message}`);
}

async function loadHook(file, extRoot, inferredType) {
  const src = shortPath(extRoot, file);
  try {
    const def = await importDefault(file);
    registry.registerHook(withInferredType(def, src, inferredType), src);
    return true;
  } catch (err) {
    fail('hook', src, err.message);
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
    fail('button', src, err.message);
    return false;
  }
}

// Returns { def, src } on success (so the caller can register the type's
// library buttons), or null on failure.
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
    const finalDef = { ...def, id: expectedId || def.id };
    registry.registerType(finalDef, src);
    return { def: finalDef, src };
  } catch (err) {
    fail('type', src, err.message);
    return null;
  }
}

// Register the library buttons a type referenced in its `buttons: [...]`,
// each scoped to that type. Returns how many registered successfully.
function loadTypeButtons(typeDef, typeId, src) {
  let n = 0;
  for (const btn of typeDef.buttons || []) {
    try {
      registry.registerButton({ ...btn, type: typeId }, `${src} (buttons[])`);
      n++;
    } catch (err) {
      fail('button', `${src} (buttons[]: '${btn?.id}')`, err.message);
    }
  }
  return n;
}

export async function loadExtensions() {
  const root = config.extensionsDir;
  if (!fs.existsSync(root)) {
    console.log(`[extensions] no directory at ${root} — skipping`);
    return;
  }

  let typeCount = 0, hookCount = 0, buttonCount = 0;
  loadFailures = []; // reset for this pass (supports reload)

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
      const loaded = await loadType(typeFile, root, id);
      if (!loaded) continue;
      typeCount++;

      // Optional per-type settings (types/<id>/settings/settings.js). Its
      // default export is handed to this type's hooks/buttons as the 3rd arg.
      const settingsFile = path.join(typeDir, 'settings', 'settings.js');
      if (fs.existsSync(settingsFile)) {
        try {
          registry.registerSettings(id, await importDefault(settingsFile));
        } catch (err) {
          fail('settings', shortPath(root, settingsFile), err.message);
        }
      }

      // Library buttons referenced in type.js (`buttons: [clone, ...]`),
      // registered scoped to this type.
      buttonCount += loadTypeButtons(loaded.def, id, loaded.src);

      for (const f of listJsFiles(path.join(typeDir, 'hooks'))) {
        if (await loadHook(f, root, id)) hookCount++;
      }
      // Folder buttons (types/<id>/buttons/*.js) still work alongside the
      // referenced library buttons.
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
    `${buttonCount} button(s) from ${root}` +
    (loadFailures.length ? `  —  ⚠ ${loadFailures.length} FAILED` : '')
  );

  // Loud, consolidated failure report so a dropped button/hook/type can't hide
  // in the boot log. Each line names what failed and why.
  if (loadFailures.length) {
    console.error(`[extensions] ⚠  ${loadFailures.length} item(s) failed to load and were skipped:`);
    for (const f of loadFailures) {
      console.error(`             ✗ ${f.kind.padEnd(8)} ${f.src}\n                 → ${f.message}`);
    }
  }
}

// Inspect the failures from the most recent load (for tests/diagnostics).
export function lastLoadFailures() {
  return [...loadFailures];
}
