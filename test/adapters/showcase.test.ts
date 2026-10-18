import { describe, expect, it } from 'vitest';
import { SHOWCASE_LEAD_MS, SHOWCASE_SESSIONS, showcaseScript } from '../../src/adapters/showcase.js';
import { DEMO_LEISURE_HOUR, demoSummaryLine } from '../../src/adapters/demo.js';
import { Collector } from '../../src/collector.js';
import { personaOf } from '../../src/scene/persona.js';

const BASE = 1_800_000_000_000;
const FLOOR = 'feature:checkout-v2';

/** Plays the whole showcase into a fresh collector, with `hourOf` defaulting to the real local hour as production does. */
async function playShowcase(hourOf?: (now: number) => number) {
  const clock = { now: BASE };
  const c = new Collector({ resolveWorkspace: async () => { throw new Error('events carry their workspace'); }, now: () => clock.now, acceptSources: ['demo'], hourOf });
  const at = new Map<number, ReturnType<Collector['floor']>>();
  for (const step of showcaseScript()) {
    clock.now = BASE + step.at;
    for (const e of step.events(clock.now)) await c.ingest(e);
    at.set(step.at, c.floor(FLOOR));
  }
  return { c, at };
}

const byId = (a: [string, unknown], b: [string, unknown]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
const leisureOf = (agents: readonly { agentId: string; leisure: string | null }[] | undefined) =>
  (agents ?? []).filter((a) => a.leisure !== null).map((a): [string, string | null] => [a.agentId, a.leisure]).sort(byId);

describe('the showcase', () => {
  it('keeps Codex and Claude Code identities through arrivals and bar breaks', async () => {
    const { c, at } = await playShowcase(() => DEMO_LEISURE_HOUR);
    for (const session of Object.values(SHOWCASE_SESSIONS)) {
      expect(c.session(session.id)!.agentKind).toBe(session.agentKind);
    }
    expect(c.session(SHOWCASE_SESSIONS.web2.id)!.agentKind).toBe('codex');
    expect(c.session(SHOWCASE_SESSIONS.web1.id)!.agentKind).toBe('claude-code');
    const rooms = at.get(SHOWCASE_LEAD_MS + 39_000)!.rooms;
    expect(rooms.flatMap((room) => room.agents).some((agent) => agent.leisure === 'biliardino')).toBe(true);
    expect(rooms.find((room) => room.hostSessionId === SHOWCASE_SESSIONS.web2.id)!.agents.some((agent) => agent.leisure === 'gintonic')).toBe(true);
  });

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

describe('the showcase personas (hq-agent-personas TP3)', () => {
  it('types its agents across at least 5 distinct personas, next to the plain explorer/generalist helpers', () => {
    const b = SHOWCASE_LEAD_MS;
    const types = showcaseScript().flatMap((step) => step.events(b + step.at)).flatMap((e) => (e.type === 'agent.started' ? [e.agentType] : []));
    const personas = new Set(types.map((t) => personaOf(t)));
    expect(personas.size).toBeGreaterThanOrEqual(5);
    expect(personas).toEqual(new Set(['explorer', 'generalist', 'none', 'techlead', 'developer', 'security', 'qa', 'reviewer', 'librarian', 'designer']));
  });

  it("shows at least 6 distinct personas in a single frame, release-check's Build phase overlapping web2's helpers", async () => {
    const { at } = await playShowcase();
    const floor = at.get(40_000)!;
    const release = floor!.rooms.find((r) => r.runId === 'wf_showcase-release')!;
    const web2 = floor!.rooms.find((r) => r.runId === 'crew:sc-web-2')!;
    const personas = new Set([...release.agents, ...web2.agents].map((a) => personaOf(a.type)));
    expect(personas.size).toBeGreaterThanOrEqual(6);
  });
});

describe("the showcase's smoke test (mega sigaro)", () => {
  it("holds a cigar on pay3's desk from its tool.started at sec 18 to its tool.finished at sec 45, with smoke:true set explicitly", async () => {
    const { at } = await playShowcase();
    const smoking = (raw: number) => {
      const occupant = at.get(raw)?.pods.flatMap((p) => p.desks).find((d) => d.occupant?.sessionId === 'sc-pay-3')?.occupant;
      return occupant ? occupant.smoking : null;
    };
    expect([36_000, 38_000, 56_000, 64_000, 65_000, 84_000].map((raw) => [raw, smoking(raw)])).toEqual([
      [36_000, null], // pay3 has not arrived yet
      [38_000, true], // arrives with a smoke-test tool.started
      [56_000, true],
      [64_000, true],
      [65_000, false], // its tool.finished clears the cigar
      [84_000, false],
    ]);
  });
});

describe("the showcase's leisure window (aperitivo/biliardino/coffee)", () => {
  it('shows a lone gin tonic (web1) at the same time web2 also holds one, then pairs web1 into biliardino once a third agent waits, once the window is forced open', async () => {
    const { at } = await playShowcase(() => DEMO_LEISURE_HOUR);
    const agentsOf = (raw: number, runId: string) => leisureOf(at.get(raw)?.rooms.find((r) => r.runId === runId)?.agents);
    // sec 36 (raw 56_000): web1 is still a lone waiter; web2's two helpers have just become one waiter + one runner.
    expect(agentsOf(56_000, 'wf_showcase-release')).toEqual([['wf_showcase-release-0', 'gintonic']]);
    expect(agentsOf(56_000, 'crew:sc-web-2')).toEqual([['sc-web2-a', 'gintonic']]);
    // sec 39 (raw 59_000): web1's Review phase starts, pairing its four finished agents into two biliardino tables;
    // web2 is still its own lone gin tonic.
    expect(agentsOf(59_000, 'wf_showcase-release')).toEqual([
      ['wf_showcase-release-0', 'biliardino'],
      ['wf_showcase-release-1', 'biliardino'],
      ['wf_showcase-release-2', 'biliardino'],
      ['wf_showcase-release-3', 'biliardino'],
    ]);
    expect(agentsOf(59_000, 'crew:sc-web-2')).toEqual([['sc-web2-a', 'gintonic']]);
  });

  it('sends the same waiters for coffee instead, outside the window', async () => {
    const { at } = await playShowcase(() => 10);
    const agentsOf = (raw: number, runId: string) => leisureOf(at.get(raw)?.rooms.find((r) => r.runId === runId)?.agents);
    expect(agentsOf(56_000, 'wf_showcase-release')).toEqual([['wf_showcase-release-0', 'coffee']]);
    expect(agentsOf(56_000, 'crew:sc-web-2')).toEqual([['sc-web2-a', 'coffee']]);
    expect(agentsOf(59_000, 'wf_showcase-release')).toEqual([
      ['wf_showcase-release-0', 'coffee'],
      ['wf_showcase-release-1', 'coffee'],
      ['wf_showcase-release-2', 'coffee'],
      ['wf_showcase-release-3', 'coffee'],
    ]);
    expect(agentsOf(59_000, 'crew:sc-web-2')).toEqual([['sc-web2-a', 'coffee']]);
  });
});
