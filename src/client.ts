import { request } from 'node:http';
import { readDaemonFile } from './daemon-file.js';

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
}

/** Calls the running daemon. Resolves null when it is not running or does not answer in time. */
export async function callDaemon<T>(dataDir: string, method: 'GET' | 'POST', path: string, timeoutMs = 1500): Promise<ApiResult<T> | null> {
  const info = await readDaemonFile(dataDir);
  if (!info) return null;
  return new Promise((resolve) => {
    const req = request(
      { host: '127.0.0.1', port: info.port, path, method, timeout: timeoutMs, headers: { authorization: `Bearer ${info.token}` } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => {
          let data: T | null = null;
          try {
            data = body ? (JSON.parse(body) as T) : null;
          } catch {
            data = null;
          }
          resolve({ ok: (res.statusCode ?? 500) < 400, status: res.statusCode ?? 0, data });
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}
