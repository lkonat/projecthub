# file-system tools

Filesystem tools shaped exactly like `shared/git/` — each file default-exports
a tool object `{ name, description, parameters, async execute(args) }` and is
imported explicitly by a hook/button (the extension loader ignores `shared/`):

```js
import fsWrite from '../../../shared/file-system/write.js';
import fsRead  from '../../../shared/file-system/read.js';

await fsWrite.execute({ path: 'notes/todo.md', content: '# Todo\n', createDirs: true });
const { content } = await fsRead.execute({ path: 'notes/todo.md' });
```

| File | `name` | What it does |
|------|--------|--------------|
| `read.js`   | `fs_read_file`      | Read a file (text or base64); refuses files over `maxBytes`. |
| `write.js`  | `fs_write_file`     | Write/overwrite a file; `createDirs`, `overwrite`. |
| `append.js` | `fs_append_file`    | Append to a file (creates it if missing). |
| `list.js`   | `fs_list_directory` | List a directory (optional `recursive`) with type/size/mtime. |
| `mkdir.js`  | `fs_make_directory` | Create a directory (recursive by default). |
| `remove.js` | `fs_remove`         | Delete a file/dir (non-empty dir needs `recursive: true`). |
| `move.js`   | `fs_move`           | Move/rename (copy+remove across devices). |
| `copy.js`   | `fs_copy`           | Copy a file/dir (recursive). |
| `stat.js`   | `fs_stat`           | Path info + existence (missing path → `{ exists: false }`). |

Each `execute` returns `{ success: true, ... }` and throws an `Error` on bad
input. Paths resolve to absolute (relative paths resolve against the server's
cwd).

## Safety: `baseDir`

Every tool accepts an optional **`baseDir`**. When set, the path(s) must resolve
**inside** it — a `../` or absolute path that escapes throws
`path escapes baseDir`. Use it to confine an operation to a project's checkout:

```js
await fsRemove.execute({ path: req.file, baseDir: project.fields.gitClone });
```

Without `baseDir` the tools operate anywhere the server process can reach, so
prefer passing one whenever the path comes from user/client input.
