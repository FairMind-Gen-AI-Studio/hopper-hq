import type { ServerResponse } from 'node:http';

/** Sent with every response. */
export const BASE_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'x-frame-options': 'DENY',
};

/**
 * The page may load only the daemon's own files: no inline code, no other hosts, no frames, no forms.
 * manifest-src and worker-src admit the web app manifest and the /ui/sw.js service worker, both same-origin only.
 */
export const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Added to HTML pages. */
export const HTML_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': CSP,
  'cross-origin-opener-policy': 'same-origin',
  'cache-control': 'no-cache',
};

/**
 * Added to bundled assets, whose file names carry a content hash. The policy too: an asset opened on its own, such as
 * an SVG, is a document of this origin. Browsers ignore it on scripts, styles and fonts.
 */
export const ASSET_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': CSP,
  'cache-control': 'public, max-age=31536000, immutable',
};

/** Added to API answers. */
export const API_HEADERS: Readonly<Record<string, string>> = { 'cache-control': 'no-store' };

/**
 * Added to the manifest and the icons. Their file names carry no content hash (the manifest names the icons by
 * fixed path, so hashing would mean rewriting it on every change), so never immutable; the icons change rarely,
 * so a day of caching is a fair middle ground between that and the manifest's own no-cache.
 */
export const MANIFEST_HEADERS: Readonly<Record<string, string>> = { 'content-security-policy': CSP, 'cache-control': 'no-cache' };
export const ICON_HEADERS: Readonly<Record<string, string>> = { 'content-security-policy': CSP, 'cache-control': 'public, max-age=86400' };

/** Added to the service worker: never cached, so the browser's update check always reaches the daemon. */
export const SW_HEADERS: Readonly<Record<string, string>> = { 'content-security-policy': CSP, 'cache-control': 'no-cache' };

export function setBaseHeaders(res: ServerResponse): void {
  for (const [name, value] of Object.entries(BASE_HEADERS)) res.setHeader(name, value);
}
