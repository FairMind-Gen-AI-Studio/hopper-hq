import { describe, expect, it } from 'vitest';

/** The build's settings as text, read without running Vite. */
const CONFIG = Object.values(import.meta.glob<string>('../../vite.config.ts', { query: '?raw', import: 'default', eager: true }))[0]!;

describe('UI build', () => {
  // The page's content policy allows scripts, styles and fonts from its own files only. These settings keep the build
  // from writing any of them into the page: no assets inlined as data: URIs, no inline preload script, no source maps,
  // and no plugin that could add any of these. The smoke test checks the built files themselves (e2e/smoke.spec.ts).
  it('writes every script, style and asset to a file of its own', () => {
    expect(CONFIG).toMatch(/\bassetsInlineLimit: 0,/);
    expect(CONFIG).toMatch(/\bmodulePreload: \{ polyfill: false \},/);
    expect(CONFIG).toMatch(/\bsourcemap: false,/);
    expect(CONFIG).toMatch(/\bplugins: \[svelte\(\)\],/);
  });
});
