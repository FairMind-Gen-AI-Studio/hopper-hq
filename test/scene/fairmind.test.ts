import { describe, expect, it } from 'vitest';
import { isFairmindAgent } from '../../src/scene/fairmind.js';

describe('isFairmindAgent', () => {
  it('is true for a type namespaced to a Fairmind plugin', () => {
    expect(isFairmindAgent('fairmind-coding:Software Engineer')).toBe(true);
    expect(isFairmindAgent('fairmind-coding:QA Engineer')).toBe(true);
    expect(isFairmindAgent('fairmind-coding:Technical Lead / Architect')).toBe(true);
    expect(isFairmindAgent('fairmind-team:Dogfood Reporter')).toBe(true);
    expect(isFairmindAgent('fairmind_internal:x')).toBe(true);
    expect(isFairmindAgent('fairmind:x')).toBe(true);
    expect(isFairmindAgent('fairmind')).toBe(true);
  });

  it('reads case-insensitively', () => {
    expect(isFairmindAgent('FairMind-Coding:Software Engineer')).toBe(true);
    expect(isFairmindAgent('FAIRMIND:x')).toBe(true);
  });

  it('is false for null, a plain subagent, a workflow agent and other namespaces', () => {
    expect(isFairmindAgent(null)).toBe(false);
    expect(isFairmindAgent('Explore')).toBe(false);
    expect(isFairmindAgent('general-purpose')).toBe(false);
    expect(isFairmindAgent('workflow-subagent')).toBe(false);
    expect(isFairmindAgent('')).toBe(false);
  });

  it('is false for a type that merely contains "fairmind" outside its namespace, or as a longer word', () => {
    expect(isFairmindAgent('something:fairmind-x')).toBe(false);
    expect(isFairmindAgent('fairmindish:x')).toBe(false);
    expect(isFairmindAgent('notfairmind:x')).toBe(false);
    expect(isFairmindAgent('fairminded:x')).toBe(false);
  });
});
