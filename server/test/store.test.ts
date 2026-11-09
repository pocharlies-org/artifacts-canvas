import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
// s3rver is a CommonJS S3-compatible mock server (docker is not assumed on CI).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const S3rver = require('s3rver');
import { loadConfig } from '../src/config.js';
import { S3CanvasObjectStore } from '../src/store.js';

let dir: string;
let s3rver: { run(): Promise<{ port: number }>; close(): Promise<void> };
let store: S3CanvasObjectStore;
let endpoint: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-s3rver-'));
  s3rver = new S3rver({
    address: '127.0.0.1',
    port: 0,
    directory: dir,
    silent: true,
    configureBuckets: [{ name: 'canvas-test' }],
  });
  const addr = await s3rver.run();
  endpoint = `http://127.0.0.1:${addr.port}`;
  store = new S3CanvasObjectStore(
    loadConfig({
      GATE_AUTHZ_URL: 'http://core/_gate/plugin/authz',
      ARTIFACT_BASE_URL: 'http://core',
      S3_BUCKET: 'canvas-test',
      S3_ENDPOINT: endpoint,
      S3_ACCESS_KEY_ID: 'S3RVER',
      S3_SECRET_ACCESS_KEY: 'S3RVER',
    }),
  );
});

afterAll(async () => {
  await s3rver.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('S3CanvasObjectStore (s3rver)', () => {
  it('round-trips a canvas object and reports readiness', async () => {
    expect(await store.ready()).toBe(true);
    const key = '_plugins/canvas/runs/x.ydoc';
    expect(await store.get(key)).toBeNull();
    await store.put(key, new Uint8Array([1, 2, 3]), 'ttl=7');
    expect(Array.from((await store.get(key))!)).toEqual([1, 2, 3]);
    await store.delete(key);
    expect(await store.get(key)).toBeNull();
  });

  it('accepts the ttl tag on put and lists under a prefix', async () => {
    await store.put('_plugins/canvas/a.ydoc', new Uint8Array([1]));
    await store.put('_plugins/canvas/b/c.ydoc', new Uint8Array([2]));
    await store.put('other/thing', new Uint8Array([3]));
    const keys = await store.list('_plugins/canvas/');
    expect(keys).toContain('_plugins/canvas/a.ydoc');
    expect(keys).toContain('_plugins/canvas/b/c.ydoc');
    expect(keys).not.toContain('other/thing');
  });
});
