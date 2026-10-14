import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('scaffold', () => {
  it('declares the package as @fairmind/scranton-hq with no runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.name).toBe('@fairmind/scranton-hq');
    expect(pkg.bin).toEqual({ 'scranton-hq': 'dist/bin.js' });
    expect(pkg.publishConfig).toEqual({ access: 'public' });
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.type).toBe('module');
  });

  it('pins the UI toolchain exactly and builds the server, then the UI', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.devDependencies).toMatchObject({
      '@fontsource-variable/archivo': '5.3.0',
      '@fontsource/ibm-plex-mono': '5.3.0',
      '@fontsource/ibm-plex-sans': '5.3.0',
      '@playwright/test': '1.63.0',
      '@sveltejs/vite-plugin-svelte': '6.2.4',
      '@types/three': '0.186.0',
      'happy-dom': '20.14.5',
      svelte: '5.57.1',
      'svelte-check': '4.7.6',
      three: '0.186.1',
      vite: '7.3.6',
    });
    const ranged = new Set(['@types/node', 'typescript', 'vitest']);
    for (const [name, version] of Object.entries(pkg.devDependencies as Record<string, string>)) {
      if (!ranged.has(name)) expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(pkg.scripts).toMatchObject({
      build: 'npm run build:server && npm run build:ui',
      'build:server': 'tsc -p tsconfig.build.json',
      'build:ui': 'vite build',
      'dev:ui': 'vite',
      typecheck:
        'tsc -p tsconfig.json --noEmit && svelte-check --tsconfig ./ui/tsconfig.json --fail-on-warnings && tsc -p e2e/tsconfig.json --noEmit',
      test: 'vitest run',
    });
  });

  it('runs the browser smoke test only on request, on the installed Chrome, outside CI', () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
    const pkg = JSON.parse(read('../package.json'));
    expect(pkg.scripts['test:e2e']).toBe('npm run build && playwright test');
    const config = read('../playwright.config.ts');
    expect(config).toMatch(/channel: 'chrome'/);
    expect(config).toContain("reporter: [['list'], ['./e2e/clean-output-reporter.ts']]");
    expect(read('../.github/workflows/ci.yml')).not.toMatch(/e2e|playwright/i);
  });
});
