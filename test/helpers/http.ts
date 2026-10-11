import { request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  json: any;
}

/** Listens on a free loopback port and resolves the port. */
export async function listen(server: Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return (server.address() as AddressInfo).port;
}

export function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((r) => server.close(() => r()));
}

export const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

/** One request to 127.0.0.1:port. Host defaults to 127.0.0.1:port; `headers` override it. */
export function call(port: number, o: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${port}`, ...o.headers };
    if (o.body !== undefined) headers['content-length'] = String(Buffer.byteLength(o.body));
    const req = request({ host: '127.0.0.1', port, path: o.path, method: o.method ?? 'GET', headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => {
        let json: unknown = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(o.body);
  });
}
