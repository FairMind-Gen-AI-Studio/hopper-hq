/**
 * Which sub-agents were spawned from a Fairmind plugin (fairmind-coding, fairmind-team, …): the renderer marks their
 * robot with the Fairmind badge (ui/renderer/fairmind-badge.ts). An agent's type is its plugin-namespaced identity,
 * e.g. 'fairmind-coding:Software Engineer' or 'fairmind-team:Dogfood Reporter'; a plain subagent's ('Explore',
 * 'general-purpose') or a workflow room agent's own tool name ('workflow-subagent') carries no such namespace.
 */

/** The part of a type before its first ':', or the whole string when it has none. */
function namespaceOf(type: string): string {
  return type.split(':', 1)[0] ?? '';
}

/** A Fairmind plugin's namespace: 'fairmind', or 'fairmind' followed by a '-' or '_' and anything, case-insensitive. */
const FAIRMIND_NAMESPACE = /^fairmind([-_].*)?$/i;

/**
 * True when `type`'s namespace (the part before its first ':') is a Fairmind plugin's: 'fairmind-coding:…',
 * 'fairmind-team:…', bare 'fairmind:…'. False for null (a session: it carries no agent type at all), a plain
 * subagent's type, a workflow agent's own tool name, and a type that merely contains 'fairmind' outside its
 * namespace ('something:fairmind-x') or as a longer word sharing the prefix ('fairmindish:x').
 */
export function isFairmindAgent(type: string | null): boolean {
  if (type === null) return false;
  return FAIRMIND_NAMESPACE.test(namespaceOf(type));
}
