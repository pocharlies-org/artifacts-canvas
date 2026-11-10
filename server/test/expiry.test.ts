import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { artifactState } from '../src/expiry.js';

const cfg = loadConfig({
  GATE_AUTHZ_URL: 'http://core/_gate/plugin/authz',
  ARTIFACT_BASE_URL: 'http://core',
  S3_BUCKET: 'b',
});

describe('artifactState (gate reason vocabulary)', () => {
  it('maps the gate gone reason (object-missing)', () => {
    expect(artifactState({ allowed: false, reason: 'object-missing' }, cfg)).toBe('gone');
  });
  it('maps the gate expired reason', () => {
    expect(artifactState({ allowed: false, reason: 'expired' }, cfg)).toBe('expired');
  });
  it('reason sets are configurable', () => {
    const custom = loadConfig({
      GATE_AUTHZ_URL: 'http://core/_gate/plugin/authz',
      ARTIFACT_BASE_URL: 'http://core',
      S3_BUCKET: 'b',
      GONE_REASONS: 'deleted',
      EXPIRED_REASONS: 'expired,ttl_expired',
    });
    expect(artifactState({ allowed: false, reason: 'deleted' }, custom)).toBe('gone');
    expect(artifactState({ allowed: false, reason: 'ttl_expired' }, custom)).toBe('expired');
    // the gate defaults no longer classify these:
    expect(artifactState({ allowed: false, reason: 'object-missing' }, custom)).toBe('alive');
  });
  it('detects a past expires date', () => {
    expect(
      artifactState({ allowed: true, reason: 'ok', artifact: { expires: '2020-01-01T00:00:00Z' } }, cfg),
    ).toBe('expired');
    expect(
      artifactState({ allowed: true, reason: 'ok', artifact: { expires: '2099-01-01T00:00:00Z' } }, cfg),
    ).toBe('alive');
  });
  it('never derives expiry for a denied visitor (no existence/expiry leak)', () => {
    expect(
      artifactState({ allowed: false, reason: 'not-listed', artifact: { expires: '2020-01-01T00:00:00Z' } }, cfg),
    ).toBe('alive');
  });
  it('alive otherwise', () => {
    expect(artifactState({ allowed: true, reason: 'ok' }, cfg)).toBe('alive');
    expect(artifactState({ allowed: false, reason: 'forbidden' }, cfg)).toBe('alive');
  });
});
