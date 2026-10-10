import { describe, expect, it } from 'vitest';
import { DEFAULT_FEATURE_RULES, deriveFeature } from '../../src/core/feature.js';

describe('deriveFeature', () => {
  it('returns null for missing, trunk, detached and generated branches', () => {
    for (const b of [null, undefined, '', '  ', 'main', 'master', 'Master', 'dev', 'develop', 'HEAD']) {
      expect(deriveFeature(b, 'shop')).toBeNull();
    }
    expect(deriveFeature('claude/distracted-merkle-82a816', 'shop')).toBeNull();
    expect(deriveFeature('worktree-agent-a1b2', 'shop')).toBeNull();
  });

  it('uses the last path segment, lower-cased', () => {
    expect(deriveFeature('feat/checkout-v2', 'storefront-web')).toBe('checkout-v2');
    expect(deriveFeature('feature/Prod-VPN-Access', 'infra')).toBe('prod-vpn-access');
    expect(deriveFeature('user/feat/search-ranking', 'search-svc')).toBe('search-ranking');
    expect(deriveFeature('live-demo', 'site')).toBe('live-demo');
  });

  it('strips a trailing repo-name token when the slug has three or more parts', () => {
    expect(deriveFeature('judge/r24-rubric-plugins', 'fairmind-plugins')).toBe('r24-rubric');
    expect(deriveFeature('judge/r24-rubric-telemetry', 'fm-telemetry')).toBe('r24-rubric');
    expect(deriveFeature('judge/r24-rubric-brain', 'brain')).toBe('r24-rubric');
    // two parts: never stripped, so 'search-api' stays the same key in every repo
    expect(deriveFeature('feat/search-api', 'orders-api')).toBe('search-api');
    // last part is not a repo token
    expect(deriveFeature('brain-write-quota', 'fairmind-brain')).toBe('brain-write-quota');
  });

  it('prefers a ticket id anywhere in the branch, upper-cased', () => {
    expect(deriveFeature('feature/ABC-123-login', 'web')).toBe('ABC-123');
    expect(deriveFeature('fix/cu-86cazw5uc-typo', 'web')).toBe('CU-86CAZW5UC');
    expect(deriveFeature('CU-86cazw5uc', 'api')).toBe('CU-86CAZW5UC');
  });

  it('does not treat dates or lower-case words as tickets', () => {
    expect(deriveFeature('docs/release-note-2026-09-26', 'site')).toBe('release-note-2026-09-26');
  });

  it('accepts custom rules', () => {
    const rules = { ...DEFAULT_FEATURE_RULES, trunkBranches: ['trunk'], ticketPatterns: [/\b(T\d+)\b/] };
    expect(deriveFeature('main', 'x', rules)).toBe('main');
    expect(deriveFeature('trunk', 'x', rules)).toBeNull();
    expect(deriveFeature('feat/T42-thing', 'x', rules)).toBe('T42');
  });
});
