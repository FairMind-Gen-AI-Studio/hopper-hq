import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { HOOK_EVENTS, mapHookPayload } from '../src/adapters/claude-code/hooks.js';

const source = readFileSync(new URL('../mod/hooks/register.tsx', import.meta.url), 'utf8');
const sent = [...new Set(
  source.split('\n')
    .filter((line) => line.includes('hook_event_name'))
    .flatMap((line) => [...line.matchAll(/'([A-Z][A-Za-z]+)'/g)].map((m) => m[1]!)),
)].sort();

describe('the mod and the daemon agree on payloads', () => {
  it('the mod sends only names the mapper understands', () => {
    expect(sent).toEqual(['PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'SessionEnd', 'Stop', 'SubagentStart', 'UserPromptSubmit']);
    for (const name of sent) expect(HOOK_EVENTS).toContain(name);
  });

  it('every payload the mod sends maps to at least one event', () => {
    for (const name of sent) {
      const payload = JSON.parse(readFileSync(new URL(`./fixtures/hooks/${name}.json`, import.meta.url), 'utf8'));
      expect(mapHookPayload(payload, 0).length, name).toBeGreaterThan(0);
    }
  });
});
