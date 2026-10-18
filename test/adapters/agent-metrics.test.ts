import { mkdtemp, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentMetrics } from '../../src/adapters/claude-code/agent-metrics.js';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'hq-usage-'));
  const path = join(dir, 'agent.jsonl');
  return { path, reader: new AgentMetrics(path, 'sonnet') };
}
const line = (message: object) => JSON.stringify({ type: 'assistant', message }) + '\n';

describe('agent usage', () => {
  it('preserves missing fields, rejects invalid counts, and accepts a measured zero', async () => {
    const { path, reader } = await fixture();
    await writeFile(path, line({ id: 'm1', model: 'claude-sonnet', usage: { input_tokens: 0, output_tokens: -10, cache_read_input_tokens: '3' } }));
    expect((await reader.read(true))?.usage).toEqual({ inputTokens: 0, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null });
  });

  it('discards old totals after truncation and waits for a complete appended line', async () => {
    const { path, reader } = await fixture();
    await writeFile(path, line({ id: 'long-message-id', usage: { input_tokens: 1000, output_tokens: 1000 } }));
    await reader.read(true);
    const next = line({ id: 'm2', usage: { input_tokens: 2 } });
    await writeFile(path, next.slice(0, -1));
    expect(await reader.read(true)).toMatchObject({ usage: null, complete: false });
    await appendFile(path, '\n');
    expect(await reader.read(true)).toMatchObject({ usage: { inputTokens: 2 }, complete: true });
  });

  it('reads in bounded chunks and marks an oversized skipped line as incomplete usage', async () => {
    const { path, reader } = await fixture();
    await writeFile(path, 'x'.repeat(300 * 1024) + '\n' + line({ id: 'm1', usage: { input_tokens: 2 } }));
    expect(await reader.read(true)).toMatchObject({ complete: false });
    expect(await reader.read(true)).toMatchObject({ usage: { inputTokens: 2 }, complete: false });
  });

  it('reports source cost including zero without inventing a price from the model', async () => {
    const { path, reader } = await fixture();
    expect(await reader.read(true)).toMatchObject({ costUSD: null, usage: null });
    await writeFile(path, JSON.stringify({ type: 'result', total_cost_usd: 0 }) + '\n');
    expect(await reader.read(false)).toMatchObject({ costUSD: 0 });
  });
});
