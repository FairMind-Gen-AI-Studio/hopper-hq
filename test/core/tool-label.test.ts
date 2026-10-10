import { describe, expect, it } from 'vitest';
import { toolLabel, truncate, waitingFromTool } from '../../src/core/tool-label.js';

describe('truncate', () => {
  it('collapses whitespace and cuts with an ellipsis', () => {
    expect(truncate('  a\n  b  ')).toBe('a b');
    const long = 'x'.repeat(100);
    expect(truncate(long)).toHaveLength(80);
    expect(truncate(long).endsWith('…')).toBe(true);
    expect(truncate('abcdef', 4)).toBe('abc…');
  });
});

describe('toolLabel', () => {
  it('shows the first line of a Bash command', () => {
    expect(toolLabel('Bash', { command: 'npm test\necho hi' })).toBe('Bash: npm test');
  });
  it('shows file paths relative to cwd, or the last two segments outside it', () => {
    expect(toolLabel('Edit', { file_path: '/repo/src/a.ts' }, '/repo')).toBe('Edit src/a.ts');
    expect(toolLabel('Read', { file_path: '/etc/nginx/nginx.conf' }, '/repo')).toBe('Read nginx/nginx.conf');
    expect(toolLabel('Write', { file_path: '/repo/README.md' }, '/repo/')).toBe('Write README.md');
  });
  it('labels search, web, agent and skill tools', () => {
    expect(toolLabel('Grep', { pattern: 'useCart' })).toBe('Grep useCart');
    expect(toolLabel('WebFetch', { url: 'https://example.com/a?b=1' })).toBe('WebFetch example.com');
    expect(toolLabel('WebFetch', { url: 'not a url' })).toBe('WebFetch');
    expect(toolLabel('WebSearch', { query: 'node sqlite' })).toBe('WebSearch node sqlite');
    expect(toolLabel('Agent', { description: 'Find callers', subagent_type: 'Explore' })).toBe('Agent: Find callers');
    expect(toolLabel('Task', { subagent_type: 'Explore' })).toBe('Agent: Explore');
    expect(toolLabel('Skill', { skill: 'browse' })).toBe('Skill browse');
  });
  it('splits MCP tool names into server and tool', () => {
    expect(toolLabel('mcp__claude_ai_Slack__slack_send_message', {})).toBe('claude_ai_Slack: slack_send_message');
  });
  it('falls back to the tool name and survives odd input', () => {
    expect(toolLabel('Workflow', {})).toBe('Workflow');
    expect(toolLabel('SomethingNew', 'oops')).toBe('SomethingNew');
    expect(toolLabel('Bash', null)).toBe('Bash:');
  });
});

describe('waitingFromTool', () => {
  it('maps AskUserQuestion to a question with the first question text', () => {
    expect(waitingFromTool('AskUserQuestion', { questions: [{ question: 'Redis or Postgres?' }] }))
      .toEqual({ kind: 'question', text: 'Redis or Postgres?' });
    expect(waitingFromTool('AskUserQuestion', {})).toEqual({ kind: 'question', text: 'Question' });
  });
  it('maps ExitPlanMode to a plan approval', () => {
    expect(waitingFromTool('ExitPlanMode', { plan: '...' })).toEqual({ kind: 'plan', text: 'Plan approval' });
  });
  it('returns null for ordinary tools', () => {
    expect(waitingFromTool('Bash', { command: 'ls' })).toBeNull();
  });
});
