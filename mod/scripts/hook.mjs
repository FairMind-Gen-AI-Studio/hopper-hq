import { spawn } from 'node:child_process';

// Observing a session never writes to Claude's output or makes an approval decision.
try {
  const binary = process.env.HOPPER_HQ_BIN || 'hopper-hq';
  let command = binary;
  let args = ['claude-hook'];
  let env = process.env;
  if (/\.(?:cjs|mjs|js)$/i.test(binary)) {
    command = process.execPath;
    args = [binary, ...args];
  } else if (process.platform === 'win32') {
    command = 'powershell.exe';
    args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; $cli=(Get-Command $env:HOPPER_HQ_EXECUTABLE -CommandType Application -ErrorAction Stop).Source; & $cli claude-hook; exit $LASTEXITCODE"];
    env = { ...process.env, HOPPER_HQ_EXECUTABLE: binary };
  }
  await new Promise(resolve => {
    const child = spawn(command, args, { env, stdio: ['inherit', 'ignore', 'ignore'], timeout: 2200, killSignal: 'SIGKILL', windowsHide: true });
    child.on('error', resolve);
    child.on('close', resolve);
  });
} catch {
  // A missing CLI or an unavailable daemon must not interrupt the session.
}
