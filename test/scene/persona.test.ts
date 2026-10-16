import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PERSONA_RULES, PERSONAS, personaOf, type Persona } from '../../src/scene/persona.js';

const SOURCE = fileURLToPath(new URL('../../src/scene/persona.ts', import.meta.url));

describe('personaOf', () => {
  it('maps the full agent-type cast table', () => {
    const cases: [string, Persona][] = [
      ['fairmind-coding:Software Engineer', 'developer'],
      ['fairmind-coding:QA Engineer', 'qa'],
      ['fairmind-coding:Security Engineer', 'security'],
      ['fairmind-coding:Code Reviewer', 'reviewer'],
      ['Technical Lead / Architect', 'techlead'],
      ['Debugging Specialist', 'debugger'],
      ['Explore', 'explorer'],
      ['Plan', 'planner'],
      ['general-purpose', 'generalist'],
      ['impeccable-ui', 'designer'],
      ['claude-code-guide', 'librarian'],
      ['some-documenter', 'librarian'],
    ];
    for (const [type, persona] of cases) {
      expect(personaOf(type)).toBe(persona);
    }
  });

  it('resolves overlaps by priority order', () => {
    expect(personaOf('Security Engineer')).not.toBe('developer');
    expect(personaOf('Security Engineer')).toBe('security');
    expect(personaOf('QA Engineer')).not.toBe('developer');
    expect(personaOf('QA Engineer')).toBe('qa');
    // architect beats planner: the explicit tie-break the user called out.
    expect(personaOf('Technical Lead / Architect')).toBe('techlead');
    expect(personaOf('Technical Lead / Architect')).not.toBe('planner');
    expect(personaOf('architect')).toBe('techlead');
    expect(personaOf('architect')).not.toBe('planner');
  });

  it('maps unknown and generic types to none', () => {
    for (const type of [null, undefined, '', '   ', 'workflow-subagent', 'agent', 'banana']) {
      expect(personaOf(type)).toBe('none');
    }
  });

  it('is case- and punctuation-insensitive', () => {
    expect(personaOf('SOFTWARE ENGINEER')).toBe('developer');
    expect(personaOf('software engineer')).toBe('developer');
    expect(personaOf('Software-Engineer')).toBe('developer');
  });

  it('is pure: the same input always gives the same output', () => {
    for (const type of ['Software Engineer', 'QA Engineer', 'banana', null]) {
      const first = personaOf(type);
      for (let i = 0; i < 5; i++) expect(personaOf(type)).toBe(first);
    }
  });

  it('has every non-none persona reachable through at least one example', () => {
    const reachable = new Set<Persona>();
    const examples = [
      'Security Engineer',
      'Technical Lead / Architect',
      'Code Reviewer',
      'QA Engineer',
      'Debugging Specialist',
      'claude-code-guide',
      'impeccable-ui',
      'Software Engineer',
      'Explore',
      'Plan',
      'general-purpose',
    ];
    for (const type of examples) reachable.add(personaOf(type));
    for (const persona of PERSONAS) {
      if (persona === 'none' || persona === 'boss') continue;
      expect(reachable.has(persona)).toBe(true);
    }
  });

  it("gives the session's main robot the boss persona, regardless of type", () => {
    expect(personaOf(null, 'session')).toBe('boss');
    expect(personaOf(undefined, 'session')).toBe('boss');
    expect(personaOf('', 'session')).toBe('boss');
    // The session carries no sub-agent type in practice, but boss wins even if one were set.
    expect(personaOf('Software Engineer', 'session')).toBe('boss');
  });

  it('never gives a subagent the boss persona, default kind included', () => {
    expect(personaOf('workflow-subagent')).not.toBe('boss');
    expect(personaOf('workflow-subagent', 'subagent')).not.toBe('boss');
    expect(personaOf('agent', 'subagent')).not.toBe('boss');
    expect(personaOf(null, 'subagent')).toBe('none');
    expect(personaOf('Software Engineer', 'subagent')).toBe('developer');
  });

  it('exports the ordered rule table used to implement personaOf', () => {
    expect(PERSONA_RULES.length).toBeGreaterThan(0);
    expect(PERSONA_RULES.at(0)?.persona).toBe('security');
    expect(PERSONA_RULES.map((r) => r.persona)).not.toContain('boss');
    expect(PERSONA_RULES.map((r) => r.persona)).not.toContain('none');
  });

  it('exports every persona id, including boss and none, exactly once', () => {
    expect(new Set(PERSONAS).size).toBe(PERSONAS.length);
    expect(PERSONAS).toContain('boss');
    expect(PERSONAS).toContain('none');
  });

  it('has no three.js or DOM import in its source', () => {
    const source = readFileSync(SOURCE, 'utf8');
    expect(/from\s+['"]three['"]/.test(source)).toBe(false);
    expect(/\bdocument\./.test(source)).toBe(false);
    expect(/\bwindow\./.test(source)).toBe(false);
  });
});
