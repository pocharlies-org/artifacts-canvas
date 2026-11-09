import { describe, expect, it } from 'vitest';
import { TokenBucket } from '../src/limits.js';

describe('TokenBucket', () => {
  it('allows a burst up to capacity, then blocks', () => {
    let now = 0;
    const b = new TokenBucket(10, 5, () => now);
    for (let i = 0; i < 5; i++) expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
  });

  it('refills at the configured rate', () => {
    let now = 0;
    const b = new TokenBucket(10, 5, () => now);
    for (let i = 0; i < 5; i++) b.take();
    expect(b.take()).toBe(false);
    now += 200; // 2 tokens at 10/s
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
  });

  it('never exceeds capacity after long idle', () => {
    let now = 0;
    const b = new TokenBucket(10, 5, () => now);
    now += 60_000;
    let taken = 0;
    while (b.take()) taken++;
    expect(taken).toBe(5);
  });
});
