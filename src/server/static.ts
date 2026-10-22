import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';

export interface UiFile {
  body: Buffer;
  type: string;
}

/** URL path ('/ui/index.html', '/ui/assets/…') -> file. Requests are answered from this map only: no disk access, no traversal. */
export type UiBundle = ReadonlyMap<string, UiFile>;

export const UI_LIMITS = { files: 300, bytes: 30 * 1024 * 1024 };

const HTML_TYPE = 'text/html; charset=utf-8';

/** Asset types. No HTML: the one page is index.html. */
const TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/**
 * PWA files vite copies next to index.html (ui/public/…), each at a fixed, unhashed name. Fixed, not from the
 * request: reading them by name keeps the same no-traversal guarantee as index.html. Any one of them may be
 * missing (an older build, or a UI built without PWA assets); that is not an error, it is just not served.
 */
const TOP_LEVEL_FILES = ['manifest.webmanifest', 'sw.js', 'icon-192.png', 'icon-512.png', 'icon-512-maskable.png', 'apple-touch-icon.png'];

/**
 * Reads `index.html` and the regular files under `assets/` once, into memory. Files with other extensions and
 * symbolic links are skipped; loading stops at the limits, and `log` hears how many files were left out.
 * Null when there is no `index.html` (the UI is not built).
 */
export async function loadUiBundle(dir: string, limits = UI_LIMITS, log: (line: string) => void = () => {}): Promise<UiBundle | null> {
  let index: Buffer;
  try {
    index = await readFile(join(dir, 'index.html'));
  } catch {
    return null;
  }
  const files = new Map<string, UiFile>([['/ui/index.html', { body: index, type: HTML_TYPE }]]);
  let bytes = index.length;
  for (const name of TOP_LEVEL_FILES) {
    const body = await readFile(join(dir, name)).catch(() => null);
    if (!body || bytes + body.length > limits.bytes) continue;
    bytes += body.length;
    files.set('/ui/' + name, { body, type: TYPES[extname(name).toLowerCase()]! });
  }
  const assets = join(dir, 'assets');
  const found = await readdir(assets, { recursive: true, withFileTypes: true }).catch(() => []);
  const paths = found.filter((e) => e.isFile() && TYPES[extname(e.name).toLowerCase()]).map((e) => join(e.parentPath, e.name)).sort();
  let loaded = 0;
  for (const path of paths) {
    const { size } = await stat(path);
    if (files.size >= limits.files || bytes + size > limits.bytes) break;
    bytes += size;
    const urlPath = '/ui/assets/' + relative(assets, path).split(sep).join('/');
    files.set(urlPath, { body: await readFile(path), type: TYPES[extname(path).toLowerCase()]! });
    loaded++;
  }
  const left = paths.length - loaded;
  if (left > 0) {
    log(`hopper-hq left ${left} UI file${left === 1 ? '' : 's'} out, over its limits of ${limits.files} files and ${limits.bytes} bytes: the browser view may not work.`);
  }
  return files;
}
