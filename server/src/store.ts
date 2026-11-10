import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Config } from './config.js';

/**
 * One Yjs document per artifact, stored as a single object at
 * `<canvasPrefix>/<artifact key>.ydoc` with credentials scoped to that prefix (core
 * plugin contract §8.3). The `ttl` tag of the artifact is copied onto the object so
 * storage lifecycle expires it with the artifact (design §6.3).
 */
export interface CanvasObjectStore {
  /** null when the object does not exist. */
  get(objectKey: string): Promise<Uint8Array | null>;
  /** `tagging` is an S3 tag string, e.g. "ttl=7". */
  put(objectKey: string, body: Uint8Array, tagging?: string): Promise<void>;
  delete(objectKey: string): Promise<void>;
  /** All object keys under `prefix` (paginated). */
  list(prefix: string): Promise<string[]>;
  /** Cheap reachability check for readiness (works with the prefix-scoped plugin user). */
  ready(): Promise<boolean>;
}

export class S3CanvasObjectStore implements CanvasObjectStore {
  private readonly client: S3Client;
  constructor(private readonly cfg: Config) {
    this.client = new S3Client({
      region: cfg.s3Region,
      ...(cfg.s3Endpoint ? { endpoint: cfg.s3Endpoint } : {}),
      forcePathStyle: cfg.s3ForcePathStyle,
      ...(cfg.s3AccessKeyId && cfg.s3SecretAccessKey
        ? {
            credentials: {
              accessKeyId: cfg.s3AccessKeyId,
              secretAccessKey: cfg.s3SecretAccessKey,
            },
          }
        : {}),
    });
  }

  async get(objectKey: string): Promise<Uint8Array | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.cfg.s3Bucket, Key: objectKey }),
      );
      const bytes = await res.Body?.transformToByteArray();
      return bytes ?? new Uint8Array(0);
    } catch (err) {
      if (err instanceof NoSuchKey || err instanceof NotFound) return null;
      throw err;
    }
  }

  async put(objectKey: string, body: Uint8Array, tagging?: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.cfg.s3Bucket,
        Key: objectKey,
        Body: body,
        ContentType: 'application/octet-stream',
        ...(tagging ? { Tagging: tagging } : {}),
      }),
    );
  }

  async delete(objectKey: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.cfg.s3Bucket, Key: objectKey }),
    );
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.cfg.s3Bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const o of res.Contents ?? []) if (o.Key) keys.push(o.Key);
      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);
    return keys;
  }

  async ready(): Promise<boolean> {
    // A one-key list of our own prefix, not HeadBucket: the core's plugin-<name> user only
    // has ListBucket restricted to `_plugins/<name>/*` (docs/plugins.md §3), so a
    // HeadBucket (bucket-level ListBucket, no prefix) is denied and readiness never passed.
    try {
      await this.client.send(
        new ListObjectsV2Command({ Bucket: this.cfg.s3Bucket, Prefix: `${this.cfg.canvasPrefix}/`, MaxKeys: 1 }),
      );
      return true;
    } catch {
      return false;
    }
  }
}

/** In-memory store for tests (same contract as the S3 one). */
export class MemoryCanvasObjectStore implements CanvasObjectStore {
  readonly objects = new Map<string, { body: Uint8Array; tagging?: string }>();
  readyNow = true;

  async get(objectKey: string): Promise<Uint8Array | null> {
    const o = this.objects.get(objectKey);
    return o ? o.body : null;
  }
  async put(objectKey: string, body: Uint8Array, tagging?: string): Promise<void> {
    this.objects.set(objectKey, { body, tagging });
  }
  async delete(objectKey: string): Promise<void> {
    this.objects.delete(objectKey);
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
  async ready(): Promise<boolean> {
    return this.readyNow;
  }
}
