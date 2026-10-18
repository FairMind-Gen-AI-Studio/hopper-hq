import { forwardHook } from '../forward.js';

export async function forwardClaudeHook(input: AsyncIterable<Buffer | string> = process.stdin, env = process.env): Promise<void> {
  await forwardHook('/api/hooks', input, env);
}
