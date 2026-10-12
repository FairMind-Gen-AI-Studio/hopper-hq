import { describe, expect, it } from 'vitest';
import { compile, parse } from 'svelte/compiler';
import ts from 'typescript';

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

/**
 * Script without its comments, which may name what the code avoids. TypeScript's printer drops the comments and
 * keeps every string, template and regular expression whole: a '//' or '/*' inside one is not a comment.
 */
function uncommented(file: string, source: string): string {
  const kind = file.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  return ts.createPrinter({ removeComments: true }).printFile(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind));
}

interface Read {
  /** The code the browser runs, without comments: a component as Svelte compiles it, a script as written. */
  code: string;
  /** What a component's markup puts in the page that the content policy or the text rule forbids. */
  markup: string[];
}

const reads = new Map<string, Read>();

function read(file: string, source: string): Read {
  const key = file + '\0' + source;
  let r = reads.get(key);
  if (!r) {
    r = readNow(file, source);
    reads.set(key, r);
  }
  return r;
}

function readNow(file: string, source: string): Read {
  if (file.endsWith('.svelte')) {
    const js = compile(source, { generate: 'client', filename: file }).js.code;
    return { code: uncommented(file + '.js', js), markup: markupViolations(source, js) };
  }
  if (/\.(?:ts|js)$/.test(file)) return { code: uncommented(file, source), markup: [] };
  if (file.endsWith('.html')) return { code: source.replace(/<!--[\s\S]*?-->/g, ''), markup: [] };
  return { code: source.replace(/\/\*[\s\S]*?\*\//g, ''), markup: [] };
}

/** True when the tree under `node` holds a node of this type. */
function holds(node: unknown, type: string): boolean {
  if (Array.isArray(node)) return node.some((n) => holds(n, type));
  if (typeof node !== 'object' || node === null) return false;
  if ((node as { type?: unknown }).type === type) return true;
  return Object.values(node).some((v) => holds(v, type));
}

/**
 * A component's markup, checked on what Svelte makes of it. `{@html}` comes from the parsed markup. Style comes from
 * the compiled templates, the HTML Svelte writes into the page as it is: a style attribute there, quoted or not, or a
 * <style> element in the markup or in <svelte:head>, is inline style, which the content policy blocks.
 * (style:prop={…} and style={…} are set from script, through the style property, which the policy allows.)
 */
function markupViolations(source: string, js: string): string[] {
  const out = new Set<string>();
  if (holds(parse(source, { modern: true }).fragment, 'HtmlTag')) out.add('{@html}');
  for (const [, html] of js.matchAll(/\$\.from_\w+\(\s*`((?:[^`\\]|\\[\s\S])*)`/g)) {
    if (/\sstyle\s*=/i.test(html!)) out.add('a static style attribute');
    if (/<style[\s>/]/i.test(html!)) out.add('a <style> element');
  }
  if (/\$\.append_styles\b/.test(js)) out.add('component styles injected by script');
  return [...out];
}

/** Untrusted text must reach the page as text, and the CSP allows no inline code or style (outline §2.5). */
const BANNED: Array<[string, RegExp]> = [
  ['innerHTML', /\binnerHTML\b/],
  ['outerHTML', /\bouterHTML\b/],
  ['insertAdjacentHTML', /\binsertAdjacentHTML\b/],
  ['createContextualFragment', /\bcreateContextualFragment\b/],
  ['DOMParser', /\bDOMParser\b|\bparseFromString\b/],
  ['setHTMLUnsafe', /\b(?:set|parse)HTMLUnsafe\b/],
  ['srcdoc', /\bsrcdoc\b/i],
  ['document.write', /\bdocument\.write/],
  ['new Function', /\bnew\s+Function\s*\(/],
  ['eval', /(?:^|[^.\w$])eval\s*\(/],
  ['setAttribute("style")', /\bsetAttribute(?:NS)?\((?:[^,)]*,)?\s*["'`]style["'`]/i],
];
/** The page's HTML: a style attribute written into a tag. */
const STATIC_STYLE: [string, RegExp] = ['a static style attribute', /<[a-zA-Z][^<>]*\sstyle\s*=/i];

function textViolations(file: string, source: string): string[] {
  const { code, markup } = read(file, source);
  const rules = file.endsWith('.html') ? [...BANNED, STATIC_STYLE] : BANNED;
  return [...markup, ...rules.filter(([, re]) => re.test(code)).map(([name]) => name)];
}

/** What `ui/` may import from `src/`: the browser-safe scene modules, and the core types as types only (outline §2.1). */
const SHARED = new Set(['../src/scene/types', '../src/scene/palette', '../src/scene/text', '../src/scene/layout']);
const PACKAGES = /^(?:svelte|three)(?:\/|$)/;

function importViolations(file: string, source: string): string[] {
  const { code } = read(file, source);
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

/**
 * The 3D renderer, three.js included, is most of the UI's code, and loads only when a floor opens (lib/renderer.ts).
 * Outside renderer/, a file the page ships may name it as a type, which leaves no import behind; only lib/renderer.ts
 * loads it, with a dynamic import. Tests are not shipped.
 */
function splitViolations(file: string, source: string): string[] {
  if (file.startsWith('renderer/') || file.startsWith('test/')) return [];
  const { code } = read(file, source);
  const dir = file.split('/').slice(0, -1).join('/');
  const intoRenderer = (spec: string) => spec.startsWith('.') && normalize(dir + '/' + spec).startsWith('renderer/');
  const out: string[] = [];
  for (const m of code.matchAll(/\b(?:import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]/g)) {
    if (!m[1] && intoRenderer(m[2]!)) out.push(`${m[2]}: loads the renderer with the page; name it as a type, or load it through lib/renderer.ts`);
  }
  for (const m of code.matchAll(/\bimport\s*\(\s*['"`]([^'"`]+)['"`]/g)) {
    if (intoRenderer(m[1]!) && file !== 'lib/renderer.ts') out.push(`${m[1]}: only lib/renderer.ts loads the renderer`);
  }
  return out;
}

/** A component with this script and markup. */
const svelte = (markup: string, script = '') => `<script lang="ts">\n${script}\n</script>\n\n${markup}\n`;

describe('UI source hygiene', () => {
  it('reads the whole UI', () => {
    expect(Object.keys(SOURCES)).toEqual(expect.arrayContaining(['App.svelte', 'main.ts', 'index.html', 'test/app.test.ts']));
    expect(Object.keys(SOURCES)).not.toContain('test/hygiene.test.ts');
  });

  it('flags what the import rules forbid and allows the rest', () => {
    expect(importViolations('components/A.svelte', svelte('<p>x</p>', "import { readFileSync } from 'node:fs';"))).toHaveLength(1);
    expect(importViolations('components/A.svelte', svelte('<p>x</p>', "import { toView } from '../../src/core/view';"))).toHaveLength(1);
    expect(importViolations('lib/a.ts', "import { STATE_LABEL } from '../../src/core/types';")).toHaveLength(1);
    expect(importViolations('lib/a.ts', "import { cleanText } from '../../src/scene/text.js';")).toHaveLength(1);
    expect(importViolations('lib/a.ts', "import { x } from './b.ts';")).toHaveLength(1);
    expect(importViolations('lib/a.ts', "import { describe } from 'vitest';")).toHaveLength(1);
    expect(importViolations('lib/a.ts', "const m = await import('node:os');")).toHaveLength(1);
    // A '//' inside a string ends no line: the import after it still counts.
    expect(importViolations('lib/a.ts', "const sep = 'a//b'; const m = await import('node:os');")).toHaveLength(1);
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
      "// import { toView } from '../../src/core/view';",
    ].join('\n');
    expect(importViolations('lib/a.ts', allowed)).toEqual([]);
    expect(importViolations('components/A.svelte', svelte('<p>{cleanText(x)}</p>', allowed + '\nlet x = $state(1);'))).toEqual([]);
    expect(importViolations('test/a.test.ts', "import { describe } from 'vitest';")).toEqual([]);
  });

  it('flags what the text rules forbid and allows the rest', () => {
    expect(textViolations('components/A.svelte', svelte('<p>{@html title}</p>', 'let { title } = $props();'))).toEqual(['{@html}']);
    expect(textViolations('lib/a.ts', 'el.innerHTML = s;')).toEqual(['innerHTML']);
    for (const markup of ['<div class="x"\n  style="color: red"></div>', '<div style=color:red></div>', '<svg><rect STYLE="fill: red" /></svg>']) {
      expect(textViolations('components/A.svelte', markup), markup).toEqual(['a static style attribute']);
    }
    for (const markup of ['<div><style>p { color: red; }</style></div>', '<svelte:head><style>p { color: red; }</style></svelte:head>']) {
      expect(textViolations('components/A.svelte', markup), markup).toEqual(['a <style> element']);
    }
    expect(textViolations('components/A.svelte', '<svelte:options css="injected" />\n<p>x</p>\n<style>p { color: red; }</style>')).toEqual([
      'component styles injected by script',
    ]);
    expect(textViolations('lib/a.ts', "el.setAttribute('style', s);")).toEqual(['setAttribute("style")']);
    expect(textViolations('lib/a.ts', 'el.setAttribute(`STYLE`, s);')).toEqual(['setAttribute("style")']);
    expect(textViolations('lib/a.ts', 'const v = eval(s);')).toEqual(['eval']);
    expect(textViolations('lib/a.ts', 'range.createContextualFragment(s);')).toEqual(['createContextualFragment']);
    expect(textViolations('lib/a.ts', "new DOMParser().parseFromString(s, 'text/html');")).toEqual(['DOMParser']);
    expect(textViolations('lib/a.ts', 'el.setHTMLUnsafe(s);')).toEqual(['setHTMLUnsafe']);
    expect(textViolations('lib/a.ts', 'frame.srcdoc = s;')).toEqual(['srcdoc']);
    expect(textViolations('lib/a.ts', "fetch('http://x/y'); el.innerHTML = s;")).toEqual(['innerHTML']);
    // A '//' or '/*' inside a string, or in the text of the markup, is not a comment.
    expect(textViolations('lib/a.ts', "const sep = 'a//b'; el.innerHTML = s;")).toEqual(['innerHTML']);
    expect(textViolations('lib/a.ts', "const g = 'src/*'; el.innerHTML = s; const h = '*/';")).toEqual(['innerHTML']);
    expect(textViolations('components/A.svelte', svelte('<p>Q/E rotate // R resets {@html help}</p>', 'let { help } = $props();'))).toEqual(['{@html}']);
    // Code in the markup counts as much as code in the script.
    expect(textViolations('components/A.svelte', svelte('<button onclick={() => (el.innerHTML = s)}>x</button>', 'let { el, s } = $props();'))).toEqual(['innerHTML']);
    // Allowed: style directives and the style property, words in comments, and a page without inline style.
    expect(textViolations('components/A.svelte', svelte('<div class="x" style:--sw={c}></div>', 'let { c } = $props();'))).toEqual([]);
    expect(textViolations('lib/a.ts', "const style = 'night'; el.style.setProperty('--x', v); retrieval(x);")).toEqual([]);
    expect(textViolations('lib/a.ts', '/** Labels use textContent, never innerHTML. */\n// no eval(), no {@html}\nlabel.textContent = s; // not innerHTML')).toEqual([]);
    expect(textViolations('components/A.svelte', svelte('<!-- no style="" here, no {@html} -->\n<p>{s}</p>', '// not innerHTML\nlet { s } = $props();'))).toEqual([]);
    expect(textViolations('index.html', '<!-- no style="" here -->\n<p>ok</p>')).toEqual([]);
    expect(textViolations('index.html', '<p style=color:red>ok</p>')).toEqual(['a static style attribute']);
  });

  it('renders untrusted text as text and keeps code and style out of the markup', () => {
    for (const [file, source] of Object.entries(SOURCES)) expect(textViolations(file, source), file).toEqual([]);
  });

  it('imports only browser-safe modules and UI packages', () => {
    for (const [file, source] of Object.entries(SOURCES)) {
      if (/\.(?:ts|js|svelte)$/.test(file)) expect(importViolations(file, source), file).toEqual([]);
    }
  });

  it('flags what the renderer split forbids and allows the rest', () => {
    expect(splitViolations('components/A.svelte', svelte('<p>x</p>', "import { WebGLUnavailableError } from '../renderer/index';"))).toHaveLength(1);
    expect(splitViolations('lib/a.ts', "import { mountFloorView } from '../renderer/index';")).toHaveLength(1);
    expect(splitViolations('lib/a.ts', "export * from '../renderer/view';")).toHaveLength(1);
    expect(splitViolations('lib/a.ts', "import { type FloorView } from '../renderer/index';")).toHaveLength(1);
    expect(splitViolations('main.ts', "import './renderer/labels.css';")).toHaveLength(1);
    expect(splitViolations('lib/a.ts', "const r = await import('../renderer/index');")).toHaveLength(1);
    expect(splitViolations('components/A.svelte', svelte('<p>x</p>', 'const load = () => import(`../renderer/index`);'))).toHaveLength(1);
    // Allowed: a type, the loader, the renderer's own files, and tests.
    expect(splitViolations('lib/renderer.ts', "import type * as R from '../renderer/index';\nexport const load = () => import('../renderer/index');")).toEqual([]);
    expect(splitViolations('components/A.svelte', svelte('<p>x</p>', "import type { FloorView } from '../renderer/index';\nimport { cleanText } from '../../src/scene/text';"))).toEqual([]);
    expect(splitViolations('renderer/view.ts', "import { LabelLayer } from './labels';")).toEqual([]);
    expect(splitViolations('test/a.test.ts', "import { WebGLUnavailableError } from '../renderer/index';")).toEqual([]);
  });

  it('loads the 3D renderer only when a floor opens: a type elsewhere, and imported by lib/renderer.ts alone', () => {
    for (const [file, source] of Object.entries(SOURCES)) {
      if (/\.(?:ts|js|svelte)$/.test(file)) expect(splitViolations(file, source), file).toEqual([]);
    }
    expect(read('lib/renderer.ts', SOURCES['lib/renderer.ts']!).code).toMatch(/\bimport\(\s*['"]\.\.\/renderer\/index['"]\s*\)/);
  });

  it('loads every script of the page from a file', () => {
    const html = SOURCES['index.html']!;
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag).toMatch(/\ssrc=/);
    expect(html).not.toMatch(/<style\b/);
  });
});
