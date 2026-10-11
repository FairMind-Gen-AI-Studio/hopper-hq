import { request, type IncomingHttpHeaders } from 'node:http';

export interface SseMessage {
  event: string | null;
  data: string | null;
  retry: number | null;
  comment: string | null;
}

export interface SseStream {
  status: number;
  headers: IncomingHttpHeaders;
  /** Every message so far, in arrival order. */
  messages: SseMessage[];
  /** The raw body so far (for answers that are not a stream). */
  body: string;
  /** Resolves with the first message after the last one taken that matches; waits for it if needed. */
  take(match?: (m: SseMessage) => boolean, timeoutMs?: number): Promise<SseMessage>;
  /** Resolves when the server ends the stream. */
  ended: Promise<void>;
  close(): void;
}

export const isEvent = (event: string) => (m: SseMessage) => m.event === event;

function parse(block: string): SseMessage {
  const m: SseMessage = { event: null, data: null, retry: null, comment: null };
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) {
      m.comment = line.slice(1).trim();
      continue;
    }
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') m.event = value;
    else if (field === 'data') m.data = m.data === null ? value : `${m.data}\n${value}`;
    else if (field === 'retry') m.retry = Number(value);
  }
  return m;
}

/** Opens GET `path` on 127.0.0.1:port and parses server-sent events as they arrive. Resolves once the headers are in. */
export function openSse(port: number, path: string, headers: Record<string, string> = {}): Promise<SseStream> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}`, accept: 'text/event-stream', ...headers } }, (res) => {
      const messages: SseMessage[] = [];
      const waiters = new Set<() => void>();
      let buffer = '';
      let cursor = 0;
      const stream: SseStream = {
        status: res.statusCode ?? 0,
        headers: res.headers,
        messages,
        body: '',
        take(match = () => true, timeoutMs = 3000) {
          return new Promise((ok, fail) => {
            const look = (): boolean => {
              for (let i = cursor; i < messages.length; i++) {
                if (!match(messages[i]!)) continue;
                cursor = i + 1;
                ok(messages[i]!);
                return true;
              }
              return false;
            };
            if (look()) return;
            const check = () => {
              if (!look()) return;
              clearTimeout(timer);
              waiters.delete(check);
            };
            const timer = setTimeout(() => {
              waiters.delete(check);
              fail(new Error('timed out waiting for a server-sent event'));
            }, timeoutMs);
            waiters.add(check);
          });
        },
        ended: new Promise((r) => res.on('end', () => r())),
        close: () => req.destroy(),
      };
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        stream.body += chunk;
        buffer += chunk;
        for (let i = buffer.indexOf('\n\n'); i >= 0; i = buffer.indexOf('\n\n')) {
          messages.push(parse(buffer.slice(0, i)));
          buffer = buffer.slice(i + 2);
        }
        for (const w of [...waiters]) w();
      });
      res.on('error', () => {});
      resolve(stream);
    });
    req.on('error', reject);
    req.end();
  });
}
