import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';

const DIR = new URL('../../src/scene/', import.meta.url);
/** The only server-side module in src/scene. Every other file there is bundled into the browser. */
const SERVER_ONLY = new Set(['build.ts']);

/**
 * Import specifiers that break the browser boundary: a shared scene module may import its siblings,
 * and `import type` from core/types.ts. Nothing else: no node: builtins, no packages, no other src/ module.
 */
function violations(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const out: string[] = [];
  for (const m of code.matchAll(/\b(?:import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]/g)) {
    const spec = m[2]!;
    if (spec.startsWith('./') && !spec.includes('..')) continue;
    if (spec === '../core/types.js' && m[1]) continue;
    out.push(m[0]);
  }
  for (const m of code.matchAll(/\b(?:import|require)\s*\(\s*['"][^'"]+['"]/g)) out.push(m[0]);
  return out;
}

describe('the browser boundary of src/scene', () => {
  it('flags what the rule forbids and allows the rest', () => {
    expect(violations("import { readFileSync } from 'node:fs';")).toHaveLength(1);
    expect(violations("import { DEFAULT_THRESHOLDS } from '../config.js';")).toHaveLength(1);
    expect(violations("import { toView } from '../core/view.js';")).toHaveLength(1);
    expect(violations("import { type Session } from '../core/types.js';")).toHaveLength(1);
    expect(violations("import * as THREE from 'three';")).toHaveLength(1);
    expect(violations("const os = await import('node:os');")).toHaveLength(1);
    expect(violations("import type { Session } from '../core/types.js';\nimport { slotOf } from './palette.js';\nexport { cleanText } from './text.js';")).toEqual([]);
  });

  it('keeps every shared scene module free of Node and server imports', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.ts') && !SERVER_ONLY.has(f)).sort();
    expect(files).toEqual(expect.arrayContaining(['palette.ts', 'text.ts', 'types.ts']));
    for (const file of files) {
      const source = readFileSync(new URL(file, DIR), 'utf8');
      expect(violations(source), file).toEqual([]);
      expect(source, file).not.toMatch(/['"]node:/);
    }
  });
});
