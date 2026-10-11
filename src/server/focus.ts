import { execFile } from 'node:child_process';

export type TmuxRunner = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
export interface FocusDriver {
  simulated: boolean;
  focus(pane: string): Promise<FocusOutcome>;
}
export type FocusOutcome = { ok: true } | { ok: false; reason: 'invalid_pane' | 'no_client' | 'tmux_failed' };

const PANE = /^%\d+$/;
const TTY = /^\/dev\/[\w./-]+$/;

/** Runs tmux without a shell. tmux talks to the server named in $TMUX, or the default socket. A failure to start counts as an exit code. */
const execTmux: TmuxRunner = (args) =>
  new Promise((resolve) => {
    execFile('tmux', args, { timeout: 2000 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** The tty of the most recently active attached client, or null. */
function pickClient(listing: string): string | null {
  let best: { activity: number; tty: string } | null = null;
  for (const line of listing.split('\n')) {
    const m = /^(\d+) (\S+)$/.exec(line.trim());
    if (!m || !TTY.test(m[2]!)) continue;
    const activity = Number(m[1]);
    if (!best || activity > best.activity) best = { activity, tty: m[2]! };
  }
  return best?.tty ?? null;
}

/** Switches the user's tmux client to a pane. The pane comes from a known session, never from a request. */
export function tmuxFocusDriver(run: TmuxRunner = execTmux): FocusDriver {
  return {
    simulated: false,
    async focus(pane) {
      if (!PANE.test(pane)) return { ok: false, reason: 'invalid_pane' };
      const clients = await run(['list-clients', '-F', '#{client_activity} #{client_tty}']);
      const tty = clients.code === 0 ? pickClient(clients.stdout) : null;
      if (!tty) return { ok: false, reason: 'no_client' };
      if ((await run(['switch-client', '-c', tty, '-t', pane])).code !== 0) return { ok: false, reason: 'tmux_failed' };
      await run(['select-window', '-t', pane]);
      if ((await run(['select-pane', '-t', pane])).code !== 0) return { ok: false, reason: 'tmux_failed' };
      return { ok: true };
    },
  };
}

/** The demo's driver: demo panes must never reach the user's real tmux. */
export const simulatedFocusDriver: FocusDriver = {
  simulated: true,
  focus: async (pane) => (PANE.test(pane) ? { ok: true } : { ok: false, reason: 'invalid_pane' }),
};
