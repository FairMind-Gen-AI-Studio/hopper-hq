import { forwardHook } from '../forward.js';

export async function forwardCodexHook(input: AsyncIterable<Buffer | string> = process.stdin, env = process.env): Promise<void> {
  await forwardHook('/api/hooks/codex', input, env);
}
