import { describe, expect, it } from 'vitest';
import { SHOWCASE_LEAD_MS, SHOWCASE_SESSIONS, showcaseScript } from '../../src/adapters/showcase.js';
import { demoSummaryLine } from '../../src/adapters/demo.js';
import { Collector } from '../../src/collector.js';

const BASE = 1_800_000_000_000;
const FLOOR = 'feature:checkout-v2';

describe('the showcase', () => {
  it('plays in time order, after its lead, and writes every session its own summary line', () => {
    const steps = showcaseScript();
    expect(steps.map((s) => s.at)).toEqual([...steps.map((s) => s.at)].sort((a, b) => a - b));
    expect(steps[0]!.at).toBe(0);
    expect(steps[1]!.at).toBeGreaterThanOrEqual(SHOWCASE_LEAD_MS);
    for (const s of Object.values(SHOWCASE_SESSIONS)) expect(demoSummaryLine(`Title: ${s.title}`)).toBe(s.summary);
  });

  it('fills a floor, grows a second block, opens rooms for runs and for subagents, and ends with no room open', async () => {
    const clock = { now: BASE };
    const c = new Collector({ resolveWorkspace: async () => { throw new Error('events carry their workspace'); }, now: () => clock.now, acceptSources: ['demo'] });
    const seen = { rooms: 0, kinds: new Set<string>(), blocks: 1, hosts: new Set<string>(), sessions: 0 };
    for (const step of showcaseScript()) {
      clock.now = BASE + step.at;
      for (const e of step.events(clock.now)) await c.ingest(e);
      const floor = c.floor(FLOOR)!;
      seen.rooms = Math.max(seen.rooms, floor.rooms.length);
      for (const r of floor.rooms) seen.kinds.add(r.kind);
      seen.blocks = Math.max(seen.blocks, floor.pods.length / 2);
      seen.sessions = Math.max(seen.sessions, floor.pods.flatMap((p) => p.desks).filter((d) => d.occupant).length + floor.unseated.length);
      for (const d of floor.pods.flatMap((p) => p.desks)) if (d.occupant?.at.kind === 'room') seen.hosts.add(d.occupant.sessionId);
    }
    expect(seen.kinds).toEqual(new Set(['workflow', 'crew']));
    expect(seen.rooms).toBeGreaterThanOrEqual(3);
    expect(seen.blocks).toBe(2);
    expect(seen.sessions).toBe(12);
    expect(seen.hosts.size).toBeGreaterThanOrEqual(4);
    expect(c.floor(FLOOR)!.rooms).toEqual([]);
  });
});
