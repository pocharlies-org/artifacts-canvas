import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The server reuses the client's stamper and protocol code (docs/protocol.md §5) as
 * byte-identical vendored copies whose only difference is the import specifier. This
 * guard fails if either drifts from the client source once both branches are merged
 * (in a server-only checkout the client directory is absent and the test skips).
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

function normalize(src: string): string {
  return src
    .replace(/from\s+'\.\/(doc|types)(\.js)?'/g, "from './client-model.js'")
    .replace(/from\s+'\.\.\/model\/(types|doc)(\.js)?'/g, "from './client-model.js'")
    .replace(/\r\n/g, '\n')
    .trim();
}

const pairs: [string, string][] = [
  ['client/src/model/stamper.ts', 'server/src/vendor/stamper.ts'],
  ['client/src/collab/protocol.ts', 'server/src/vendor/protocol.ts'],
];

describe('vendored client code', () => {
  for (const [clientPath, vendorPath] of pairs) {
    it(`${path.basename(vendorPath)} matches the client source`, () => {
      const clientFile = path.join(repoRoot, clientPath);
      if (!fs.existsSync(clientFile)) return; // server-only checkout: nothing to compare yet
      const vendorFile = path.join(repoRoot, vendorPath);
      expect(fs.existsSync(vendorFile), `${vendorPath} missing`).toBe(true);
      expect(normalize(fs.readFileSync(vendorFile, 'utf8'))).toBe(normalize(fs.readFileSync(clientFile, 'utf8')));
    });
  }
});
