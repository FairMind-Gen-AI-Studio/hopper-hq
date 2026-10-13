import { describe, expect, it } from 'vitest';
import { parseScriptMeta } from '../../src/adapters/claude-code/script-meta.js';

/** A script as the Workflow tool keeps it: the meta literal first, then code that is never read. */
const SCRIPT = `export const meta = {
  name: 'checkout-verify',
  description: 'Verify split payments end to end',
  phases: [
    { title: 'Plan', detail: 'opus: a task list per repo', model: 'opus' },
    { title: 'Build', detail: 'sonnet: tasks by wave', model: 'sonnet' },
    { title: 'Review' },
  ],
}

const PLAN = '/home/dev/plans/checkout.md'
export default async function run() {
  await phase('Plan', () => agent(\`Read \${PLAN}\`))
}
`;

const meta = (literal: string) => parseScriptMeta(`export const meta = ${literal}\n`);

describe('parseScriptMeta', () => {
  it("reads a script's name, description and phase titles, and nothing after its meta", () => {
    expect(parseScriptMeta(SCRIPT)).toEqual({ name: 'checkout-verify', description: 'Verify split payments end to end', phases: ['Plan', 'Build', 'Review'] });
  });

  it('reads quoted keys, both quotes, templates without a placeholder, escapes, numbers, words, comments and trailing commas', () => {
    expect(meta(`{
      // the run
      "name": "orders\\u0041pi", /* inline */ 'description': \`line one
line two, cost $5\`,
      limits: { retries: 3, ratio: -1.5e3, zero: 0, on: true, off: false, none: null, list: [1, 2.5, [], {},], },
      phases: [{ title: 'It\\'s \\"done\\"\\t\\\\ \\\`now\\\`\\n' }, { 'title': "Ship", }],
    }`)).toEqual({ name: 'ordersApi', description: 'line one line two, cost $5', phases: ['It\'s "done" \\ `now`', 'Ship'] });
    expect(meta('{}')).toEqual({ name: null, description: null, phases: [] });
  });

  it('takes nothing from a meta with anything outside the literal grammar', () => {
    const rejected = [
      '{ name: `checkout-${id}` }',
      '{ name: makeName() }',
      '{ name: NAME }',
      '{ ...base, name: "x" }',
      '{ [key]: "x" }',
      '{ name: () => "x" }',
      '{ name: /x/ }',
      '{ name: "a\\x41" }',
      '{ name: "a\\rb" }',
      '{ name: "a\\0" }',
      '{ name: "a\\\nb" }',
      '{ name: "a\nb" }',
      "{ name: 'unterminated }",
      '{ n: 0x1F }',
      '{ n: .5 }',
      '{ n: 5. }',
      '{ n: +1 }',
      '{ n: 1_000 }',
      '{ n: Infinity }',
      '{ n: undefined }',
      '{ list: [1,, 2] }',
      '{ a: 1 b: 2 }',
      '{ a: 1,, }',
      '{ name: "x" /* never closed }',
      '{ name: truer }',
      '{ name: "x"',
    ];
    for (const literal of rejected) expect([literal, meta(literal)]).toEqual([literal, null]);
  });

  it('finds no meta unless the script exports it as an object literal at the start of a line', () => {
    expect(parseScriptMeta('export default async function run() {}\n')).toBeNull();
    expect(parseScriptMeta('export const metadata = { name: "x" }\n')).toBeNull();
    expect(parseScriptMeta('const meta = { name: "x" }\n')).toBeNull();
    expect(parseScriptMeta('export const meta = makeMeta()\n')).toBeNull();
    expect(parseScriptMeta('// export const meta = { name: "x" }\n')).toBeNull();
    expect(parseScriptMeta('// a header\nexport  const meta =\n  { name: "x" }\n')).toMatchObject({ name: 'x' });
  });

  it('reads at most 256 KiB of script, a literal of at most 64 KiB and 8 levels of nesting', () => {
    expect(parseScriptMeta(SCRIPT + ' '.repeat(256 * 1024 - SCRIPT.length))).not.toBeNull();
    expect(parseScriptMeta(SCRIPT + ' '.repeat(256 * 1024 - SCRIPT.length + 1))).toBeNull();
    expect(meta(`{ name: "x", pad: "${'p'.repeat(64 * 1024 - 30)}" }`)).toMatchObject({ name: 'x' });
    expect(meta(`{ name: "x", pad: "${'p'.repeat(64 * 1024)}" }`)).toBeNull();
    const nested = (levels: number) => `{ name: "x", deep: ${'['.repeat(levels - 1)}${']'.repeat(levels - 1)} }`;
    expect(meta(nested(8))).toMatchObject({ name: 'x' });
    expect(meta(nested(9))).toBeNull();
  });

  it('cleans and caps the name, the description and the phase titles, and skips phases without a text title', () => {
    const titles = Array.from({ length: 40 }, (_, i) => `{ title: "P${i + 1}" }`).join(', ');
    expect(meta(`{ name: "Ship\u0007 it\u202E ${'n'.repeat(200)}", description: "${'d'.repeat(300)}", phases: [{ title: "${'t'.repeat(100)}" }, { title: 7 }, "Plan", null, { title: " \u0007 " }, { detail: "x" }, ${titles}] }`))
      .toEqual({
        name: `Ship it ${'n'.repeat(111)}\u2026`,
        description: `${'d'.repeat(199)}\u2026`,
        phases: [`${'t'.repeat(79)}\u2026`, ...Array.from({ length: 31 }, (_, i) => `P${i + 1}`)],
      });
    expect(meta('{ name: 42, description: ["x"], phases: { title: "Plan" } }')).toEqual({ name: null, description: null, phases: [] });
  });

  it('reads a key such as __proto__ as a plain key', () => {
    expect(meta('{ __proto__: { name: "x" }, constructor: 1, phases: [{ __proto__: { title: "y" } }] }')).toEqual({ name: null, description: null, phases: [] });
  });
});
