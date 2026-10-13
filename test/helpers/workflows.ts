/** The text the Workflow tool returns when it launches a run, as Claude Code words it (redacted). Lines left out are absent. */
export function launchText(o: { runId: string; summary?: string; scriptPath?: string }): string {
  return [
    'Workflow launched in background. Task ID: w0000aaaa',
    ...(o.summary === undefined ? [] : [`Summary: ${o.summary}`]),
    `Transcript dir: /home/dev/.claude/projects/-home-dev-shop/11111111-1111-4111-8111-111111111111/subagents/workflows/${o.runId}`,
    ...(o.scriptPath === undefined
      ? []
      : [`Script file: ${o.scriptPath}`, `(Edit this file with Write/Edit and re-invoke Workflow with {scriptPath: "${o.scriptPath}"} to iterate without resending the script.)`]),
    `Run ID: ${o.runId}`,
    `To resume after editing the script: Workflow({scriptPath: "<script>", resumeFromRunId: "${o.runId}"}) - completed agents return cached results.`,
    '',
    'You will be notified when it completes. Use /workflows to watch live progress.',
  ].join('\n');
}

/** A transcript entry: the user turn that carries a tool's result. */
export function resultEntry(content: unknown, timestamp = '2026-10-10T10:00:30.000Z'): object {
  return { type: 'user', timestamp, isSidechain: false, message: { role: 'user', content: [{ tool_use_id: 'toolu_06ABCDEFGHIJKLMNOPQRSTUV', type: 'tool_result', content, is_error: false }] } };
}
