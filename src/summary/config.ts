import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type ProviderName = 'claude-cli' | 'anthropic-api';
export interface SummaryConfig {
  enabled: boolean;
  provider: ProviderName;
  /** Null: the provider's default (claude-cli: 'haiku'; anthropic-api: 'claude-haiku-5-5'). */
  model: string | null;
}
export const DEFAULT_SUMMARY_CONFIG: SummaryConfig = { enabled: false, provider: 'claude-cli', model: null };
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export const PROVIDER_NAMES: readonly ProviderName[] = ['claude-cli', 'anthropic-api'];

export function isProviderName(value: unknown): value is ProviderName {
  return PROVIDER_NAMES.includes(value as ProviderName);
}

/** hopper-hq's settings file: `{ "summaries": { ... } }`, beside other keys it keeps. */
export function configPath(dataDir: string): string {
  return join(dataDir, 'config.json');
}

/** The summarizer's working directory. Sessions there are its own, and stay out of the building. */
export function summarizerDir(dataDir: string): string {
  return join(dataDir, 'summarizer');
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The summaries settings from what the file holds: each invalid field falls back to its default. */
function parseSummaries(raw: unknown): SummaryConfig {
  const s = isObject(raw) ? raw : {};
  return {
    enabled: typeof s.enabled === 'boolean' ? s.enabled : DEFAULT_SUMMARY_CONFIG.enabled,
    provider: isProviderName(s.provider) ? s.provider : DEFAULT_SUMMARY_CONFIG.provider,
    model: typeof s.model === 'string' && MODEL_PATTERN.test(s.model) ? s.model : null,
  };
}

/** The file's top-level object; null when it is missing. Throws when it holds anything but a JSON object. */
async function readObject(path: string): Promise<Json | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  if (!isObject(data)) throw new Error(`${path} does not hold a JSON object. Fix or remove it.`);
  return data;
}

/** The summaries settings. A file that is missing, unreadable or not a JSON object gives the defaults; so does a missing `summaries` key. */
export async function readSummaryConfig(dataDir: string): Promise<SummaryConfig> {
  try {
    return parseSummaries((await readObject(configPath(dataDir)))?.summaries);
  } catch {
    return { ...DEFAULT_SUMMARY_CONFIG };
  }
}

/**
 * Changes the summaries settings and returns them. Every other top-level key is kept. The file is written whole to a
 * temporary file beside it, then renamed over it, readable by the owner only. Rejects a model that fails MODEL_PATTERN,
 * an unknown provider, and a file that holds anything but a JSON object, leaving the file as it was.
 */
export async function writeSummaryConfig(dataDir: string, patch: Partial<SummaryConfig>): Promise<SummaryConfig> {
  if (patch.model !== undefined && patch.model !== null && !MODEL_PATTERN.test(patch.model)) throw new Error(`Invalid model: ${patch.model}`);
  if (patch.provider !== undefined && !isProviderName(patch.provider)) throw new Error(`Unknown provider: ${String(patch.provider)}`);
  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') throw new Error('enabled must be true or false');
  const path = configPath(dataDir);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const file = (await readObject(path)) ?? {};
  const next: SummaryConfig = { ...parseSummaries(file.summaries) };
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (patch.provider !== undefined) next.provider = patch.provider;
  if (patch.model !== undefined) next.model = patch.model;
  const temp = join(dataDir, `.config.json.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temp, JSON.stringify({ ...file, summaries: next }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await chmod(temp, 0o600);
    await rename(temp, path);
  } catch (err) {
    await unlink(temp).catch(() => {});
    throw err;
  }
  return next;
}

/**
 * readSummaryConfig, read again only when the file changed: another inode (each write renames a new file over it), size
 * or modification time.
 */
export function cachedSummaryConfig(dataDir: string): () => Promise<SummaryConfig> {
  let cache: { key: string; config: SummaryConfig } | null = null;
  return async () => {
    const st = await stat(configPath(dataDir)).catch(() => null);
    const key = st ? `${st.ino}:${st.size}:${st.mtimeMs}` : 'none';
    if (cache?.key !== key) cache = { key, config: await readSummaryConfig(dataDir) };
    return cache.config;
  };
}
