import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface DaemonFile {
  port: number;
  token: string;
  pid: number;
  startedAt: number;
}

export const daemonFilePath = (dataDir: string): string => join(dataDir, 'daemon.json');

export async function readDaemonFile(dataDir: string): Promise<DaemonFile | null> {
  try {
    const d = JSON.parse(await readFile(daemonFilePath(dataDir), 'utf8')) as Partial<DaemonFile>;
    if (typeof d.port === 'number' && typeof d.token === 'string') return d as DaemonFile;
  } catch {
    // missing or unreadable
  }
  return null;
}

export async function writeDaemonFile(dataDir: string, info: DaemonFile): Promise<void> {
  const path = daemonFilePath(dataDir);
  await writeFile(path, JSON.stringify(info), { mode: 0o600 });
  await chmod(path, 0o600);
}

/** Removes the file only if it still belongs to this process. */
export async function removeDaemonFile(dataDir: string, pid: number): Promise<void> {
  const current = await readDaemonFile(dataDir);
  if (current && current.pid === pid) await rm(daemonFilePath(dataDir), { force: true });
}
