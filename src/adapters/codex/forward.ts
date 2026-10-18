import { execFile } from 'node:child_process';
import { request } from 'node:http';
import { resolvePaths } from '../../config.js';
import { readDaemonFile } from '../../daemon-file.js';
import { object } from './rollout.js';

/** Optional observer hook: silent on stdout, bounded input, no decisions and no Codex configuration writes. */
export async function forwardCodexHook(input: AsyncIterable<Buffer | string> = process.stdin, env = process.env): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of input) {
      const part = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += part.length;
      if (size > 900_000) return;
      chunks.push(part);
    }
    const payload = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (!payload.session_id || !payload.hook_event_name) return;
    const info = await readDaemonFile(resolvePaths({}, env).dataDir);
    if (!info) return;
    const pane = env.TMUX_PANE;
    if (pane && /^%\d+$/.test(pane)) {
      payload.hopper_tmux_pane = pane;
      const session = await new Promise<string>((resolve) => {
        execFile('tmux', ['display-message', '-p', '-t', pane, '#{session_name}'], { timeout: 500, env }, (err, stdout) => resolve(err ? '' : stdout.trim()));
      });
      if (session) payload.hopper_tmux_session = session;
    }
    payload._hopper_ts = Date.now();
    const body = JSON.stringify(payload);
    await new Promise<void>((resolve) => {
      const req = request({ host: '127.0.0.1', port: info.port, path: '/api/hooks/codex', method: 'POST', timeout: 1000,
        headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => { res.resume(); res.on('end', resolve); });
      req.on('error', () => resolve());
      req.on('timeout', () => { req.destroy(); resolve(); });
      req.end(body);
    });
  } catch { /* Observing a session must never interrupt it, including when the daemon is down. */ }
}
