import { MemoryStore } from '../core/memory';
import { createSample } from '../core/sample';
import { validateGeometry } from '../geometry';
import type { AppState, DesktopAPI, Transaction } from '../shared/model';

export interface Session {
  mode: 'desktop' | 'preview';
  load(): Promise<AppState>;
  transact(tx: Transaction): Promise<AppState>;
  undo(revision: number): Promise<AppState>;
  redo(revision: number): Promise<AppState>;
}

export function createSession(): Session {
  const desktop = (globalThis as { home?: DesktopAPI }).home;
  if (desktop) {
    return {
      mode: 'desktop',
      load: () => desktop.state(),
      transact: tx => desktop.transact({ ...tx, source: 'user', allowedIds: undefined }),
      undo: revision => desktop.undo(revision),
      redo: revision => desktop.redo(revision),
    };
  }
  const store = new MemoryStore(createSample(), validateGeometry);
  const state = (): AppState => ({ ...store.getState(), location: 'In-memory preview' });
  return {
    mode: 'preview',
    load: async () => state(),
    transact: async tx => {
      store.transact({ ...tx, source: 'user', allowedIds: undefined });
      return state();
    },
    undo: async revision => {
      store.undo(revision);
      return state();
    },
    redo: async revision => {
      store.redo(revision);
      return state();
    },
  };
}
