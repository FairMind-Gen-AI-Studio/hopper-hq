import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('scaffold', () => {
  it('declares the package as scranton-hq with no runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.name).toBe('scranton-hq');
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.type).toBe('module');
  });
});
