import { createSample } from '../src/core/sample';
import { ProjectStore, type StoreHooks } from '../src/core/store';
import { validateGeometry } from '../src/geometry';

const mode = process.argv[2];
const db = process.argv[3];
if (!mode || !db) throw new Error('crash worker requires a mode and a database path');

function block(signal: string): void {
  process.send?.(signal);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

const hooks: StoreHooks = {};
if (mode === 'hang-before') hooks.beforeCommit = () => block('armed');
if (mode === 'hang-after') hooks.afterCommit = () => block('armed');

if (mode === 'try-open') {
  try {
    const store = new ProjectStore(db, createSample(), validateGeometry);
    store.close();
    process.send?.('opened');
  } catch (error) {
    process.send?.(error instanceof Error ? error.message : String(error));
  }
  process.exit(0);
}

const store = new ProjectStore(db, createSample(), validateGeometry, hooks);
const rename = {
  requestId: `crash-${mode}`,
  baseRevision: 0,
  label: 'Rename during crash probe',
  source: 'user' as const,
  commands: [{ type: 'rename' as const, name: mode === 'hang-before' ? 'Rolled back' : 'Committed' }],
};

if (mode === 'hold-open') block('ready');
else if (mode === 'hold-committed' || mode === 'hang-before' || mode === 'hang-after') {
  store.transact(rename);
  if (mode === 'hold-committed') block('ready');
  else process.send?.('returned');
} else {
  throw new Error(`Unknown crash mode ${mode}`);
}
