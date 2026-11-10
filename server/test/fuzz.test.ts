import { describe, expect, it } from 'vitest';
import { runFuzz } from './fuzz/guard-fuzz.js';

/**
 * CI slice of the guard fuzzer (test/fuzz/guard-fuzz.ts; the full run is
 * `npx tsx server/test/fuzz/guard-fuzz.ts 1000000`): random raw updates from an attacker,
 * the server path (guard + applyGuarded), and the ledger oracle — the ledger only ever
 * changes through the stamper, attributed to the attacker for the attacker's own edits.
 */
describe('guard fuzz (ledger oracle)', () => {
  it('30 000 random updates: no finding', () => {
    const r = runFuzz(30_000, 7);
    expect(r.accepted).toBeGreaterThan(100);
    expect(r.findings).toEqual({});
  }, 120_000);
});
