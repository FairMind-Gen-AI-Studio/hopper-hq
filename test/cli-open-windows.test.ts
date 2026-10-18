import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn }));
import { openInBrowser } from '../src/cli.js';

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
it('opens the Windows browser without interpreting URL characters as shell code', async () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' });
  const url = 'http://127.0.0.1:7337/ui/login?code=abc&next=$(whoami)';
  const child = Object.assign(new EventEmitter(), { unref() {} });
  spawn.mockImplementation(() => { queueMicrotask(() => child.emit('exit', 0)); return child; });
  await openInBrowser(url);
  expect(spawn).toHaveBeenCalledWith('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:HOPPER_HQ_BROWSER_URL'], expect.objectContaining({ env: expect.objectContaining({ HOPPER_HQ_BROWSER_URL: url }), windowsHide: true }));
});
