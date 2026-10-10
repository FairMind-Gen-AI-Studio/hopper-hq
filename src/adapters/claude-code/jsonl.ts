import { open, stat } from 'node:fs/promises';

export interface TailState {
  path: string;
  /** Byte offset of the next unread line. Always just after a newline (or 0). */
  offset: number;
  /** True while skipping the rest of a line longer than maxBytes. */
  skipping: boolean;
}

const NL = 0x0a;

async function fileSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

async function readChunk(path: string, position: number, length: number): Promise<Buffer> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, position);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

function splitLines(buf: Buffer): string[] {
  return buf.toString('utf8').split('\n').filter((l) => l.trim() !== '');
}

/** Complete lines appended since state.offset. */
export async function readNewLines(state: TailState, maxBytes = 4 * 1024 * 1024): Promise<{ lines: string[]; state: TailState }> {
  const size = await fileSize(state.path);
  if (size === null) return { lines: [], state };
  let offset = state.offset;
  let skipping = state.skipping;
  if (size < offset) {
    offset = 0;
    skipping = false;
  }
  if (size === offset) return { lines: [], state: { path: state.path, offset, skipping } };

  const buf = await readChunk(state.path, offset, Math.min(size - offset, maxBytes));
  let from = 0;
  if (skipping) {
    const nl = buf.indexOf(NL);
    if (nl === -1) return { lines: [], state: { path: state.path, offset: offset + buf.length, skipping: true } };
    from = nl + 1;
    skipping = false;
  }
  const last = buf.lastIndexOf(NL);
  if (last < from) {
    if (from === 0 && buf.length === maxBytes) {
      return { lines: [], state: { path: state.path, offset: offset + buf.length, skipping: true } };
    }
    return { lines: [], state: { path: state.path, offset: offset + from, skipping } };
  }
  return { lines: splitLines(buf.subarray(from, last)), state: { path: state.path, offset: offset + last + 1, skipping } };
}

/** Complete lines within the first `bytes` of the file. */
export async function readHeadLines(path: string, bytes = 64 * 1024): Promise<string[]> {
  const size = await fileSize(path);
  if (!size) return [];
  const buf = await readChunk(path, 0, Math.min(size, bytes));
  const last = buf.lastIndexOf(NL);
  return last === -1 ? [] : splitLines(buf.subarray(0, last));
}

/** Complete lines within the last `bytes` of the file, and the offset to keep tailing from. */
export async function readTailLines(path: string, bytes = 512 * 1024): Promise<{ lines: string[]; offset: number }> {
  const size = await fileSize(path);
  if (!size) return { lines: [], offset: 0 };
  const start = Math.max(0, size - bytes);
  const buf = await readChunk(path, start, size - start);
  let from = 0;
  if (start > 0) {
    const nl = buf.indexOf(NL);
    if (nl === -1) return { lines: [], offset: size };
    from = nl + 1;
  }
  const last = buf.lastIndexOf(NL);
  if (last < from) return { lines: [], offset: start + from };
  return { lines: splitLines(buf.subarray(from, last)), offset: start + last + 1 };
}
