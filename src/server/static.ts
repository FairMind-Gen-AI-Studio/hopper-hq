import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';

export interface UiFile {
  body: Buffer;
  type: string;
}

/** URL path ('/ui/index.html', '/ui/assets/…') -> file. Requests are answered from this map only: no disk access, no traversal. */
export type UiBundle = ReadonlyMap<string, UiFile>;

export const UI_LIMITS = { files: 300, bytes: 30 * 1024 * 1024 };

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Reads `index.html` and the regular files under `assets/` once, into memory. Files with other extensions and
 * symbolic links are skipped; loading stops at the limits. Null when there is no `index.html` (the UI is not built).
 */
export async function loadUiBundle(dir: string, limits = UI_LIMITS): Promise<UiBundle | null> {
  let index: Buffer;
  try {
    index = await readFile(join(dir, 'index.html'));
  } catch {
    return null;
  }
  const files = new Map<string, UiFile>([['/ui/index.html', { body: index, type: TYPES['.html']! }]]);
  let bytes = index.length;
  const assets = join(dir, 'assets');
  const found = await readdir(assets, { recursive: true, withFileTypes: true }).catch(() => []);
  const paths = found.filter((e) => e.isFile() && TYPES[extname(e.name).toLowerCase()]).map((e) => join(e.parentPath, e.name)).sort();
  for (const path of paths) {
    const { size } = await stat(path);
    if (files.size >= limits.files || bytes + size > limits.bytes) break;
    bytes += size;
    const urlPath = '/ui/assets/' + relative(assets, path).split(sep).join('/');
    files.set(urlPath, { body: await readFile(path), type: TYPES[extname(path).toLowerCase()]! });
  }
  return files;
}
