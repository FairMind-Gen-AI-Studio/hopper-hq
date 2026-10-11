import { describe, expect, it } from 'vitest';

/**
 * Every source file of the UI as text, keyed by its path under ui/. This file is left out: it names what it bans.
 * Vite reads them at test time, so the check needs no Node API.
 */
const SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>(['../**/*.{ts,js,svelte,html,css}', '!./hygiene.test.ts'], { query: '?raw', import: 'default', eager: true }),
  ).map(([key, text]) => [normalize('test/' + key), text]),
);

/** 'test/../components/x.svelte' -> 'components/x.svelte'; paths leaving ui/ start with '../'. */
function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..' && out.length && out[out.length - 1] !== '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/** Untrusted text must reach the page as text, and the CSP allows no inline code or style (outline §2.5). */
const BANNED: Array<[string, RegExp]> = [
  ['{@html}', /\{@html\b/],
  ['innerHTML', /\binnerHTML\b/],
  ['outerHTML', /\bouterHTML\b/],
  ['insertAdjacentHTML', /\binsertAdjacentHTML\b/],
  ['document.write', /\bdocument\.write/],
  ['new Function', /\bnew\s+Function\s*\(/],
  ['eval', /(?:^|[^.\w$])eval\s*\(/],
  ['a static style attribute', /\sstyle\s*=\s*["']/],
  ['setAttribute("style")', /setAttribute\(\s*["']style["']/],
];

/** What `ui/` may import from `src/`: the browser-safe scene modules, and the core types as types only (outline §2.1). */
const SHARED = new Set(['../src/scene/types', '../src/scene/palette', '../src/scene/text', '../src/scene/layout']);
const PACKAGES = /^(?:svelte|three)(?:\/|$)/;

function importViolations(file: string, source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const out: string[] = [];
  const dir = file.split('/').slice(0, -1).join('/');
  const specs = [
    ...[...code.matchAll(/\b(?:import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]/g)].map((m) => ({ spec: m[2]!, type: !!m[1] })),
    ...[...code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => ({ spec: m[1]!, type: false })),
  ];
  for (const { spec, type } of specs) {
    if (spec.startsWith('.')) {
      const target = normalize(dir + '/' + spec);
      if (/\.(?:js|ts)$/.test(spec)) out.push(`${spec}: import .ts modules without an extension`);
      else if (target.startsWith('../') && !SHARED.has(target) && !(type && target === '../src/core/types')) out.push(`${spec}: not a browser-safe module`);
    } else if (spec === 'vitest') {
      if (!file.startsWith('test/')) out.push(`${spec}: only tests import vitest`);
    } else if (!PACKAGES.test(spec)) {
      out.push(`${spec}: not a UI package`);
    }
  }
  return out;
}

describe('UI source hygiene', () => {
  it('reads the whole UI', () => {
    expect(Object.keys(SOURCES)).toEqual(expect.arrayContaining(['App.svelte', 'main.ts', 'index.html', 'test/app.test.ts']));
    expect(Object.keys(SOURCES)).not.toContain('test/hygiene.test.ts');
  });

  it('flags what the import rules forbid and allows the rest', () => {
    expect(importViolations('components/A.svelte', "import { readFileSync } from 'node:fs';")).toHaveLength(1);
    expect(importViolations('components/A.svelte', "import { toView } from '../../src/core/view';")).toHaveLength(1);
    expect(importViolations('components/A.svelte', "import { STATE_LABEL } from '../../src/core/types';")).toHaveLength(1);
    expect(importViolations('lib/a.ts', "import { cleanText } from '../../src/scene/text.js';")).toHaveLength(1);
    expect(importViolations('lib/a.ts', "import { x } from './b.ts';")).toHaveLength(1);
    expect(importViolations('lib/a.ts', "import { describe } from 'vitest';")).toHaveLength(1);
    expect(importViolations('lib/a.ts', "const m = await import('node:os');")).toHaveLength(1);
    const allowed = [
      "import type { SessionState } from '../../src/core/types';",
      "import { cleanText } from '../../src/scene/text';",
      "import type { BuildingScene } from '../../src/scene/types';",
      "import { mount } from 'svelte';",
      "import { writable } from 'svelte/store';",
      "import * as THREE from 'three';",
      "import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';",
      "import TopBar from './TopBar.svelte';",
      "import { parseHash } from '../lib/route';",
      "import './styles/base.css';",
    ].join('\n');
    expect(importViolations('components/A.svelte', allowed)).toEqual([]);
    expect(importViolations('test/a.test.ts', "import { describe } from 'vitest';")).toEqual([]);
  });

  it('flags what the text rules forbid', () => {
    const hits = (s: string) => BANNED.filter(([, re]) => re.test(s)).map(([name]) => name);
    expect(hits('{@html title}')).toEqual(['{@html}']);
    expect(hits('el.innerHTML = s')).toEqual(['innerHTML']);
    expect(hits('<div style="color: red">')).toEqual(['a static style attribute']);
    expect(hits("el.setAttribute('style', s)")).toEqual(['setAttribute("style")']);
    expect(hits('const v = eval(s)')).toEqual(['eval']);
    expect(hits('<div class="x" style:--sw={c}>')).toEqual([]);
    expect(hits('el.style.setProperty("--x", v); retrieval(x); el.textContent = s')).toEqual([]);
  });

  it('renders untrusted text as text and keeps code and style out of the markup', () => {
    for (const [file, source] of Object.entries(SOURCES)) {
      for (const [name, re] of BANNED) expect(re.test(source), `${file} uses ${name}`).toBe(false);
    }
  });

  it('imports only browser-safe modules and UI packages', () => {
    for (const [file, source] of Object.entries(SOURCES)) {
      if (/\.(?:ts|js|svelte)$/.test(file)) expect(importViolations(file, source), file).toEqual([]);
    }
  });

  it('loads every script of the page from a file', () => {
    const html = SOURCES['index.html']!;
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag).toMatch(/\ssrc=/);
    expect(html).not.toMatch(/<style\b/);
  });
});
