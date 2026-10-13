/**
 * Reads the `meta` a workflow script exports, without running the script. The script is a copy Claude Code keeps of what
 * the model wrote: its text is untrusted, so only a small subset of JavaScript literals is read, and anything else makes
 * the whole meta unreadable.
 */
import { cleanOrNull } from '../../scene/text.js';

export interface ScriptMeta {
  name: string | null;
  description: string | null;
  /** Phase titles in order; at most 32, each cleaned and at most 80 characters. */
  phases: string[];
}

const MAX_SOURCE = 256 * 1024;
const MAX_LITERAL = 64 * 1024;
const MAX_DEPTH = 8;
const MAX_PHASES = 32;
/** The declaration, at the start of a line. */
const DECLARATION = /^export\s+const\s+meta\s*=\s*(?=\{)/m;
const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/y;
/** A decimal number: an optional minus, an integer part without leading zeros, an optional fraction and exponent. */
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
/** What may not follow a number or a word: a letter, a digit or `_`, `$` and `.` would make it something else. */
const TRAILING = /[A-Za-z0-9_$.]/;
const ESCAPES = new Map([['n', '\n'], ['t', '\t'], ['\\', '\\'], ["'", "'"], ['"', '"'], ['`', '`']]);
const WORDS: [string, boolean | null][] = [['true', true], ['false', false], ['null', null]];

/** Objects are read into maps: a key such as `__proto__` is only a key. */
type Literal = string | number | boolean | null | Literal[] | Map<string, Literal>;

/** Thrown by the reader at the first thing it does not accept. */
const UNREADABLE = Symbol('unreadable');

function readLiteral(src: string, from: number): Literal {
  const end = Math.min(src.length, from + MAX_LITERAL);
  let i = from;
  const fail = (): never => {
    throw UNREADABLE;
  };

  function skipSpace(): void {
    while (i < end) {
      const c = src[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') i++;
      else if (src.startsWith('//', i)) {
        const nl = src.indexOf('\n', i);
        i = nl === -1 ? end : nl + 1;
      } else if (src.startsWith('/*', i)) {
        const close = src.indexOf('*/', i + 2);
        if (close === -1) fail();
        i = close + 2;
      } else return;
    }
  }

  function consume(c: string): void {
    skipSpace();
    if (i >= end || src[i] !== c) fail();
    i++;
  }

  /** Whether the next token closes the list: then it is consumed. */
  function closes(c: string): boolean {
    skipSpace();
    if (i < end && src[i] === c) {
      i++;
      return true;
    }
    return false;
  }

  function string(quote: string): string {
    i++;
    let out = '';
    for (;;) {
      if (i >= end) fail();
      const c = src[i]!;
      if (c === quote) {
        i++;
        return out;
      }
      if (c === '\\') {
        const next = src[i + 1] ?? '';
        if (next === 'u') {
          const hex = src.slice(i + 2, i + 6);
          if (!/^[0-9A-Fa-f]{4}$/.test(hex)) fail();
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        const escaped = ESCAPES.get(next);
        if (escaped === undefined) fail();
        out += escaped;
        i += 2;
        continue;
      }
      if (quote === '`' ? c === '$' && src[i + 1] === '{' : c === '\n' || c === '\r') fail();
      out += c;
      i++;
    }
  }

  function key(): string {
    skipSpace();
    const c = src[i];
    if (c === "'" || c === '"') return string(c);
    IDENTIFIER.lastIndex = i;
    const m = IDENTIFIER.exec(src);
    if (!m || i + m[0].length > end) return fail();
    i += m[0].length;
    return m[0];
  }

  function value(depth: number): Literal {
    skipSpace();
    if (i >= end) fail();
    const c = src[i]!;
    if (c === '{' || c === '[') {
      if (depth >= MAX_DEPTH) fail();
      i++;
      return c === '{' ? object(depth + 1) : array(depth + 1);
    }
    if (c === "'" || c === '"' || c === '`') return string(c);
    NUMBER.lastIndex = i;
    const n = NUMBER.exec(src);
    if (n) {
      i += n[0].length;
      if (i > end || TRAILING.test(src[i] ?? '')) fail();
      return Number(n[0]);
    }
    for (const [word, v] of WORDS) {
      if (src.startsWith(word, i) && !TRAILING.test(src[i + word.length] ?? '')) {
        i += word.length;
        return v;
      }
    }
    return fail();
  }

  function object(depth: number): Map<string, Literal> {
    const out = new Map<string, Literal>();
    while (!closes('}')) {
      const k = key();
      consume(':');
      out.set(k, value(depth));
      if (closes('}')) break;
      consume(',');
    }
    return out;
  }

  function array(depth: number): Literal[] {
    const out: Literal[] = [];
    while (!closes(']')) {
      out.push(value(depth));
      if (closes(']')) break;
      consume(',');
    }
    return out;
  }

  return value(0);
}

/** Reads `export const meta = { … }` from a workflow script without running it. Null when there is none or it does not parse. */
export function parseScriptMeta(source: string): ScriptMeta | null {
  if (typeof source !== 'string' || source.length > MAX_SOURCE) return null;
  const m = DECLARATION.exec(source);
  if (!m) return null;
  let meta: Literal;
  try {
    meta = readLiteral(source, m.index + m[0].length);
  } catch {
    return null;
  }
  if (!(meta instanceof Map)) return null;
  const text = (v: Literal | undefined, max: number): string | null => (typeof v === 'string' ? cleanOrNull(v, max) : null);
  const phases = meta.get('phases');
  return {
    name: text(meta.get('name'), 120),
    description: text(meta.get('description'), 200),
    phases: Array.isArray(phases)
      ? phases.flatMap((p) => {
        const title = p instanceof Map ? text(p.get('title'), 80) : null;
        return title ? [title] : [];
      }).slice(0, MAX_PHASES)
      : [],
  };
}
