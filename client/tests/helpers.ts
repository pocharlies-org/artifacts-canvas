import * as Y from 'yjs';
import { CanvasDoc } from '../src/model/doc';
import { attachStamper } from '../src/model/stamper';

/** Two (or more) documents wired together like a relay would, each with its own user. */
export function linkedDocs(users: string[]): { docs: CanvasDoc[]; ydocs: Y.Doc[] } {
  const ydocs = users.map(() => new Y.Doc());
  ydocs.forEach((d, i) => {
    d.on('update', (u: Uint8Array, origin: unknown) => {
      if (origin === 'remote') return;
      ydocs.forEach((o, j) => {
        if (j !== i) Y.applyUpdate(o, u, 'remote');
      });
    });
  });
  const docs = ydocs.map((d) => new CanvasDoc(d));
  docs.forEach((cd, i) => {
    attachStamper(cd.doc, {
      userOf: (origin) => (origin === cd.origin || origin === cd.undoManager ? { id: users[i], info: { name: users[i], anonymous: false } } : null),
    });
  });
  return { docs, ydocs };
}
