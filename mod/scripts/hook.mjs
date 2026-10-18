import { spawn } from 'node:child_process';

// Observing a session never writes to Claude's output or makes an approval decision.
try {
  const binary = process.env.HOPPER_HQ_BIN || 'hopper-hq';
  let command = binary;
  let args = ['claude-hook'];
  let env = process.env;
  let windowsVerbatimArguments = false;
  if (/\.(?:cjs|mjs|js)$/i.test(binary)) {
    command = process.execPath;
    args = [binary, ...args];
  } else if (process.platform === 'win32') {
    command = process.env.ComSpec || 'cmd.exe';
    args = ['/d', '/v:off', '/s', '/c', '""%HOPPER_HQ_EXECUTABLE%" claude-hook"'];
    env = { ...process.env, HOPPER_HQ_EXECUTABLE: binary };
    windowsVerbatimArguments = true;
  }
  await new Promise(resolve => {
    const child = spawn(command, args, { env, windowsVerbatimArguments, stdio: ['inherit', 'ignore', 'ignore'], timeout: 2200, killSignal: 'SIGKILL', windowsHide: true });
    child.on('error', resolve);
    child.on('close', resolve);
  });
} catch {
  // A missing CLI or an unavailable daemon must not interrupt the session.
}
