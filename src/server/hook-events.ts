import type { RawEvent } from '../core/types.js';

/** Command hooks carry complete payloads; the UI mod additionally knows workflow membership. */
export class HookEvents {
  private readonly commandSessions = new Set<string>();

  accept(event: RawEvent, transport: string): boolean {
    if (transport === 'command') {
      this.commandSessions.delete(event.sessionId);
      this.commandSessions.add(event.sessionId);
      if (this.commandSessions.size > 4096) this.commandSessions.delete(this.commandSessions.values().next().value!);
      return true;
    }
    if (event.type === 'agent.started' && event.runId) return true;
    return !this.commandSessions.has(event.sessionId);
  }
}
