/**
 * Minimal in-memory S3-compatible endpoint for local development and the end-to-end
 * suite: exactly the operations the canvas server's S3CanvasObjectStore performs
 * (HeadBucket, GetObject, PutObject with `x-amz-tagging`, DeleteObject, ListObjectsV2),
 * path-style, credentials ignored. Objects live only in this process.
 *
 * Control API (always on — this module is never used in production):
 *   GET    /_e2e/objects            [{key, size, tagging}] under the mock
 *   GET    /_e2e/object?key=...     base64 of the stored bytes (404 when absent)
 *   DELETE /_e2e/objects            drop everything
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';

export interface MockObject {
  body: Uint8Array;
  tagging?: string;
  lastModified: string;
}

export interface S3Mock {
  url: string;
  objects: Map<string, MockObject>;
  close(): Promise<void>;
}

function xmlError(res: http.ServerResponse, status: number, code: string, message: string): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/xml');
  res.end(
    `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`,
  );
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function startS3Mock(port = 0): Promise<S3Mock> {
  const objects = new Map<string, MockObject>();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://s3');
    const p = decodeURIComponent(url.pathname);

    // --- control API ---
    if (p === '/_e2e/objects' && req.method === 'GET') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      const list = [...objects.entries()].map(([key, o]) => ({ key, size: o.body.byteLength, tagging: o.tagging ?? null }));
      res.end(JSON.stringify(list));
      return;
    }
    if (p === '/_e2e/objects' && req.method === 'DELETE') {
      objects.clear();
      res.statusCode = 204;
      res.end();
      return;
    }
    if (p === '/_e2e/object' && req.method === 'GET') {
      const key = url.searchParams.get('key') ?? '';
      const o = objects.get(key);
      if (!o) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ key, base64: Buffer.from(o.body).toString('base64'), tagging: o.tagging ?? null }));
      return;
    }

    // --- S3 API (path style: /<bucket>/<key...>) ---
    const slash = p.indexOf('/', 1);
    if (slash < 0) {
      xmlError(res, 400, 'InvalidRequest', 'path-style /<bucket>/<key> required');
      return;
    }
    const bucket = p.slice(1, slash);
    const key = p.slice(slash + 1);

    if (!key) {
      // bucket-level
      if (req.method === 'HEAD') {
        res.statusCode = 200;
        res.end();
        return;
      }
      if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
        const prefix = url.searchParams.get('prefix') ?? '';
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        const contents = keys
          .map((k) => {
            const o = objects.get(k)!;
            return `<Contents><Key>${esc(k)}</Key><LastModified>${o.lastModified}</LastModified><ETag>&quot;${createHash('md5').update(o.body).digest('hex')}&quot;</ETag><Size>${o.body.byteLength}</Size></Contents>`;
          })
          .join('');
        res.statusCode = 200;
        res.setHeader('content-type', 'application/xml');
        res.end(
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
            `<Name>${esc(bucket)}</Name><Prefix>${esc(prefix)}</Prefix><KeyCount>${keys.length}</KeyCount>` +
            `<IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
        );
        return;
      }
      xmlError(res, 405, 'MethodNotAllowed', req.method ?? '');
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const o = objects.get(key);
      if (!o) {
        xmlError(res, 404, 'NoSuchKey', 'The specified key does not exist.');
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('etag', `"${createHash('md5').update(o.body).digest('hex')}"`);
      // The AWS SDK rejects a non-RFC7231 Last-Modified; store ISO, serve RFC1123.
      res.setHeader('last-modified', new Date(o.lastModified).toUTCString());
      res.setHeader('content-length', String(o.body.byteLength));
      res.end(req.method === 'HEAD' ? undefined : Buffer.from(o.body));
      return;
    }
    if (req.method === 'PUT') {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        const body = new Uint8Array(Buffer.concat(chunks));
        const tagging = req.headers['x-amz-tagging'];
        objects.set(key, {
          body,
          ...(typeof tagging === 'string' && tagging ? { tagging } : {}),
          lastModified: new Date().toISOString(),
        });
        res.statusCode = 200;
        res.setHeader('etag', `"${createHash('md5').update(body).digest('hex')}"`);
        res.end();
      });
      return;
    }
    if (req.method === 'DELETE') {
      objects.delete(key);
      res.statusCode = 204;
      res.end();
      return;
    }
    xmlError(res, 405, 'MethodNotAllowed', req.method ?? '');
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const bound = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${bound}`,
    objects,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
