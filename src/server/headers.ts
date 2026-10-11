import type { ServerResponse } from 'node:http';

/** Sent with every response. */
export const BASE_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'x-frame-options': 'DENY',
};

/** The page may load only the daemon's own files: no inline code, no other hosts, no frames, no forms. */
export const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Added to HTML pages. */
export const HTML_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': CSP,
  'cross-origin-opener-policy': 'same-origin',
  'cache-control': 'no-cache',
};

/** Added to bundled assets, whose file names carry a content hash. */
export const ASSET_HEADERS: Readonly<Record<string, string>> = { 'cache-control': 'public, max-age=31536000, immutable' };

/** Added to API answers. */
export const API_HEADERS: Readonly<Record<string, string>> = { 'cache-control': 'no-store' };

export function setBaseHeaders(res: ServerResponse): void {
  for (const [name, value] of Object.entries(BASE_HEADERS)) res.setHeader(name, value);
}
