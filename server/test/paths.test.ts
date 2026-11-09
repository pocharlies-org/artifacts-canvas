import { describe, expect, it } from 'vitest';
import { artifactKeyFromObject, canvasObjectKey, stripBucketSegment, validateArtifactKey } from '../src/paths.js';

const ok = (raw: string, prefixes: string[] = []) => validateArtifactKey(raw, prefixes);

describe('validateArtifactKey', () => {
  it('accepts normal artifact keys', () => {
    expect(ok('runs/x/report.html').ok).toBe(true);
    expect(ok('pub/doc.canvas.html').ok).toBe(true);
    expect(ok('a/b/c/深層.html').ok).toBe(true);
    expect(ok('file (1).pdf').ok).toBe(true);
  });

  it('rejects traversal and absolute paths', () => {
    expect(ok('../etc/passwd').ok).toBe(false);
    expect(ok('a/../../b').ok).toBe(false);
    expect(ok('/etc/passwd').ok).toBe(false);
    expect(ok('a/').ok).toBe(false);
    expect(ok('a/./b').ok).toBe(false);
    expect(ok('a//b').ok).toBe(false);
  });

  it('rejects encoded traversal and bad encodings', () => {
    expect(ok('..%2f..%2fetc').ok).toBe(false);
    expect(ok('a%00b').ok).toBe(false);
    expect(ok('%zz/not-decodable').ok).toBe(false);
  });

  it('rejects control characters and backslashes', () => {
    expect(ok('a\nb').ok).toBe(false);
    expect(ok('a\tb').ok).toBe(false);
    expect(ok('a\\b').ok).toBe(false);
  });

  it('rejects the core and canvas reserved namespaces', () => {
    // never allowed, even if authz would say yes
    expect(ok('_gate/x').ok).toBe(false);
    expect(ok('_plugins/canvas/other.ydoc').ok).toBe(false);
    expect(ok('.acl.json').ok).toBe(false);
    expect(ok('a/.hidden').ok).toBe(false);
    expect(ok('_/whatever').ok).toBe(false);
    expect(ok('a/_secret').ok).toBe(false);
  });

  it('rejects oversized keys', () => {
    expect(ok('a/'.repeat(600) + 'x').ok).toBe(false);
  });

  it('applies the optional prefix allowlist', () => {
    expect(ok('pub/a.html', ['pub/']).ok).toBe(true);
    expect(ok('runs/a.html', ['pub/']).ok).toBe(false);
  });
});

describe('canvas object keys', () => {
  it('maps artifact keys under the canvas prefix', () => {
    expect(canvasObjectKey('_plugins/canvas', 'runs/x.html')).toBe('_plugins/canvas/runs/x.html.ydoc');
    expect(artifactKeyFromObject('_plugins/canvas/', '_plugins/canvas/runs/x.html.ydoc')).toBe('runs/x.html');
    expect(artifactKeyFromObject('_plugins/canvas/', '_plugins/canvas/other.txt')).toBeNull();
  });
});

describe('stripBucketSegment (core link shape -> canonical key)', () => {
  it('strips a leading bucket segment', () => {
    expect(stripBucketSegment('artifacts/pub/run/index.html', 'artifacts')).toBe('pub/run/index.html');
    expect(stripBucketSegment('canvas-test/runs/x.html', 'canvas-test')).toBe('runs/x.html');
  });
  it('strips a percent-encoded bucket segment', () => {
    expect(stripBucketSegment('my%20bucket/runs/x.html', 'my bucket')).toBe('runs/x.html');
  });
  it('leaves non-bucket first segments alone (client link shape)', () => {
    expect(stripBucketSegment('pub/run/index.html', 'artifacts')).toBe('pub/run/index.html');
    expect(stripBucketSegment('artifacts', 'artifacts')).toBe('artifacts'); // no rest: a key, not a link
  });
  it('the stripped key still validates', () => {
    expect(validateArtifactKey(stripBucketSegment('artifacts/pub/x.html', 'artifacts')).ok).toBe(true);
    expect(validateArtifactKey(stripBucketSegment('artifacts/../etc/passwd', 'artifacts')).reason).toBe('traversal');
  });
});
