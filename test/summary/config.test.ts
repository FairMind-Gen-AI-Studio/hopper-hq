import { describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cachedSummaryConfig,
  configPath,
  DEFAULT_SUMMARY_CONFIG,
  MODEL_PATTERN,
  readSummaryConfig,
  summarizerDir,
  writeSummaryConfig,
} from '../../src/summary/config.js';

const tmp = () => mkdtemp(join(tmpdir(), 'shq-config-'));
const put = (dir: string, text: string) => writeFile(configPath(dir), text);
const json = async (dir: string) => JSON.parse(await readFile(configPath(dir), 'utf8'));

describe('the summaries config', () => {
  it('lives in config.json, with the summarizer in its own directory beside it', () => {
    expect(configPath('/home/dev/.hopper-hq')).toBe('/home/dev/.hopper-hq/config.json');
    expect(summarizerDir('/home/dev/.hopper-hq')).toBe('/home/dev/.hopper-hq/summarizer');
    expect(DEFAULT_SUMMARY_CONFIG).toEqual({ enabled: false, provider: 'claude-cli', model: null });
    expect(['haiku', 'claude-haiku-5-5', 'us.anthropic.claude:1', 'a'.repeat(64)].every((m) => MODEL_PATTERN.test(m))).toBe(true);
    expect(['', 'a b', 'a/b', 'a=b', 'a'.repeat(65)].some((m) => MODEL_PATTERN.test(m))).toBe(false);
    // Never one that claude would read as an option.
    expect(['-x', '--help', '.haiku', ':x', '_x'].some((m) => MODEL_PATTERN.test(m))).toBe(false);
    expect(['9b', 'Haiku'].every((m) => MODEL_PATTERN.test(m))).toBe(true);
  });

  it('reads the defaults from a missing file, a file that is not JSON or not an object, and a file without summaries', async () => {
    const dir = await tmp();
    expect(await readSummaryConfig(dir)).toEqual(DEFAULT_SUMMARY_CONFIG);
    for (const text of ['{ not json', '[1, 2]', 'null', '{"other": {"enabled": true}}', '{"summaries": 5}']) {
      await put(dir, text);
      expect(await readSummaryConfig(dir)).toEqual(DEFAULT_SUMMARY_CONFIG);
    }
  });

  it('reads valid fields as they are and falls back field by field', async () => {
    const dir = await tmp();
    await put(dir, JSON.stringify({ summaries: { enabled: true, provider: 'anthropic-api', model: 'claude-haiku-5-5' } }));
    expect(await readSummaryConfig(dir)).toEqual({ enabled: true, provider: 'anthropic-api', model: 'claude-haiku-5-5' });
    await put(dir, JSON.stringify({ summaries: { enabled: 'yes', provider: 'anthropic-api', model: 'bad model' } }));
    expect(await readSummaryConfig(dir)).toEqual({ enabled: false, provider: 'anthropic-api', model: null });
    await put(dir, JSON.stringify({ summaries: { enabled: true, provider: 'gpt', model: 7 } }));
    expect(await readSummaryConfig(dir)).toEqual({ enabled: true, provider: 'claude-cli', model: null });
  });

  it('creates a private data directory and file, and returns what it wrote', async () => {
    const dir = join(await tmp(), 'data');
    expect(await writeSummaryConfig(dir, { enabled: true })).toEqual({ enabled: true, provider: 'claude-cli', model: null });
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(configPath(dir))).mode & 0o777).toBe(0o600);
    expect(await json(dir)).toEqual({ summaries: { enabled: true, provider: 'claude-cli', model: null } });
    expect(await readdir(dir)).toEqual(['config.json']);
  });

  it('keeps every other key and the fields the patch leaves out, and replaces the file through a rename', async () => {
    const dir = await tmp();
    await put(dir, JSON.stringify({ theme: 'night', summaries: { enabled: false, provider: 'anthropic-api', model: 'claude-x', extra: 1 } }));
    const before = await stat(configPath(dir));
    expect(await writeSummaryConfig(dir, { enabled: true })).toEqual({ enabled: true, provider: 'anthropic-api', model: 'claude-x' });
    expect(await json(dir)).toEqual({ theme: 'night', summaries: { enabled: true, provider: 'anthropic-api', model: 'claude-x' } });
    const after = await stat(configPath(dir));
    expect(after.ino).not.toBe(before.ino);
    expect(after.mode & 0o777).toBe(0o600);
    expect(await writeSummaryConfig(dir, { provider: 'claude-cli', model: null })).toEqual({ enabled: true, provider: 'claude-cli', model: null });
    expect(await readdir(dir)).toEqual(['config.json']);
  });

  it('rejects a model that fails the pattern, and a file it would have to drop, leaving the file as it was', async () => {
    const dir = await tmp();
    await put(dir, '{"summaries": {"enabled": true}}');
    await expect(writeSummaryConfig(dir, { model: 'haiku; rm -rf' })).rejects.toThrow('Invalid model: haiku; rm -rf');
    await expect(writeSummaryConfig(dir, { provider: 'gpt' as never })).rejects.toThrow('Unknown provider: gpt');
    expect(await readFile(configPath(dir), 'utf8')).toBe('{"summaries": {"enabled": true}}');
    await put(dir, '{ not json');
    await expect(writeSummaryConfig(dir, { enabled: false })).rejects.toThrow(`${configPath(dir)} does not hold a JSON object. Fix or remove it.`);
    expect(await readFile(configPath(dir), 'utf8')).toBe('{ not json');
    expect(await readdir(dir)).toEqual(['config.json']);
  });

  it('reads the file again only once it changed', async () => {
    const dir = await tmp();
    const config = cachedSummaryConfig(dir);
    expect(await config()).toEqual(DEFAULT_SUMMARY_CONFIG);
    await writeSummaryConfig(dir, { enabled: true });
    const on = await config();
    expect(on.enabled).toBe(true);
    expect(await config()).toBe(on);
    await writeSummaryConfig(dir, { enabled: false });
    expect((await config()).enabled).toBe(false);
  });
});
