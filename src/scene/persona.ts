/**
 * Which costume does this agent-type wear? Pure and deterministic: no three.js, no DOM, no I/O,
 * no Date or Math.random. The renderer (and any future server use) classifies client-side from
 * this one table, so the scene model (types.ts, SCENE_VERSION) never has to carry a persona id.
 */

/** A sub-agent's costume, or the session's own. 'none' is today's plain look. */
export type Persona =
  | 'security'
  | 'techlead'
  | 'reviewer'
  | 'qa'
  | 'debugger'
  | 'librarian'
  | 'designer'
  | 'developer'
  | 'explorer'
  | 'planner'
  | 'generalist'
  | 'boss'
  | 'none';

/** Every persona id, 'none' and 'boss' included: for exhaustiveness tests and the renderer's accessory switch. */
export const PERSONAS: readonly Persona[] = [
  'security',
  'techlead',
  'reviewer',
  'qa',
  'debugger',
  'librarian',
  'designer',
  'developer',
  'explorer',
  'planner',
  'generalist',
  'boss',
  'none',
];

/** Which kind of robot is being classified. A session carries no sub-agent type: see personaOf. */
export type PersonaKind = 'session' | 'subagent';

interface PersonaRule {
  persona: Persona;
  /** Substrings of the full normalized (lowercased, space-collapsed) type string. */
  phrases: readonly string[];
  /** Whole tokens of the type string, split on runs of non-alphanumerics. */
  tokens: readonly string[];
}

/**
 * Ordered high -> low priority; personaOf evaluates top to bottom and the first match wins.
 * A rule matches when any of its phrases is a substring of the full normalized type, or any of
 * its tokens is present as a whole token (so a plugin prefix like 'fairmind-coding:' splits into
 * harmless tokens 'fairmind' and 'coding').
 *
 * The order pins the explicit tie-breaks the user called out: 'Security Engineer' and
 * 'QA Engineer' must not fall through to 'developer' on the 'engineer' token, so security (1) and
 * qa (4) sit above developer (8). 'Technical Lead / Architect' must land on techlead, not planner
 * (strategy/plan), so techlead (2) sits above planner (10) and claims the 'architect' and 'lead'
 * tokens before they reach any other rule. 'Code Reviewer' sits above developer for the same
 * reason the 'review' token would otherwise never be reached.
 */
export const PERSONA_RULES: readonly PersonaRule[] = [
  { persona: 'security', phrases: ['secret service'], tokens: ['security', 'cyber', 'cybersecurity', 'appsec', 'secops', 'infosec'] },
  {
    persona: 'techlead',
    phrases: ['tech lead', 'technical lead', 'team lead', 'staff engineer', 'lead engineer'],
    tokens: ['techlead', 'teamlead', 'architect', 'lead', 'hartman'],
  },
  { persona: 'reviewer', phrases: ['code review'], tokens: ['review', 'reviewer'] },
  { persona: 'qa', phrases: ['quality assurance'], tokens: ['qa', 'tester', 'test', 'testing', 'quality'] },
  { persona: 'debugger', phrases: ['debugging specialist'], tokens: ['debug', 'debugger', 'bug', 'troubleshoot', 'exterminator'] },
  {
    persona: 'librarian',
    phrases: ['technical writer', 'claude code guide'],
    tokens: ['doc', 'docs', 'documenter', 'documentation', 'writer', 'guide', 'librarian'],
  },
  { persona: 'designer', phrases: ['front end'], tokens: ['design', 'designer', 'frontend', 'ui', 'ux', 'impeccable', 'artist'] },
  {
    persona: 'developer',
    phrases: ['software engineer'],
    tokens: ['developer', 'engineer', 'software', 'swe', 'coder', 'backend', 'fullstack', 'nerd'],
  },
  { persona: 'explorer', phrases: [], tokens: ['explore', 'explorer', 'research', 'scout'] },
  { persona: 'planner', phrases: [], tokens: ['plan', 'planner', 'strategy', 'strategist'] },
  { persona: 'generalist', phrases: ['general purpose'], tokens: ['generalpurpose', 'general', 'handyman', 'utility', 'helper'] },
];

/** Runs of anything but a letter or digit: how the type string splits into whole tokens. */
const SPLIT = /[^a-z0-9]+/g;

/** The persona for an agent-type string, case-insensitive, by the ordered rule table above.
 *
 * `kind` distinguishes the session's own robot from a sub-agent's: a session carries no
 * sub-agent type (the scene model has no field for one), and every session's main robot gets the
 * boss/manager look regardless of `type` — even if a type were somehow set, boss wins. Interns
 * and workflow room agents always classify with the default 'subagent' kind, from their real
 * type string; they never get boss. */
export function personaOf(type: string | null | undefined, kind: PersonaKind = 'subagent'): Persona {
  if (kind === 'session') return 'boss';

  const full = (type ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
  if (!full) return 'none';

  const tokens = new Set(full.split(SPLIT).filter(Boolean));

  for (const rule of PERSONA_RULES) {
    if (rule.phrases.some((phrase) => full.includes(phrase))) return rule.persona;
    if (rule.tokens.some((token) => tokens.has(token))) return rule.persona;
  }
  return 'none';
}
