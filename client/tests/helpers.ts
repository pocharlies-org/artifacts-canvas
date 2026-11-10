import * as Y from 'yjs';
import { CanvasDoc } from '../src/model/doc';
import { attachStamper } from '../src/model/stamper';

/**
 * Two (or more) tabs wired together like a relay would, each with its own user: the content
 * documents are linked, and so are the ledgers (what a stamping server would broadcast).
 */
export function linkedDocs(users: string[]): { docs: CanvasDoc[]; ydocs: Y.Doc[]; ledgers: Y.Doc[] } {
  const ydocs = users.map(() => new Y.Doc());
  const ledgers = users.map(() => new Y.Doc());
  for (const group of [ydocs, ledgers]) {
    group.forEach((d, i) => {
      d.on('update', (u: Uint8Array, origin: unknown) => {
        if (origin === 'remote') return;
        group.forEach((o, j) => {
          if (j !== i) Y.applyUpdate(o, u, 'remote');
        });
      });
    });
  }
  const docs = ydocs.map((d, i) => new CanvasDoc(d, ledgers[i]));
  docs.forEach((cd, i) => {
    attachStamper(cd.doc, cd.ledger, {
      userOf: (origin: unknown) => (origin === cd.origin || origin === cd.undoManager ? { id: users[i], info: { name: users[i], anonymous: false } } : null),
    });
  });
  return { docs, ydocs, ledgers };
}
