import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';

/** Raw control and bidi characters. Source writes them as \u escapes, never as the invisible characters themselves. */
const RAW = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

describe('source files', () => {
  it('carry no raw control or bidi characters', () => {
    for (const dir of ['src', 'test']) {
      const root = new URL(`../${dir}/`, import.meta.url);
      for (const file of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
        if (!/\.(ts|tsx|snap)$/.test(file)) continue;
        const lines = readFileSync(new URL(file, root), 'utf8').split('\n');
        const bad = lines.flatMap((line, i) => (RAW.test(line) ? [`${dir}/${file}:${i + 1}`] : []));
        expect(bad).toEqual([]);
      }
    }
  });
});
