import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/core/canonical';
import { MemoryStore } from '../src/core/memory';
import { exportProjectBundle } from '../src/core/snapshot';
import { createSample } from '../src/core/sample';
import { ProjectStore } from '../src/core/store';
import { validateGeometry } from '../src/geometry';
import { instanceWorldPose } from '../src/placement';
import type { Project, Transaction } from '../src/shared/model';

const stores: ProjectStore[] = [];
const directories: string[] = [];
let workerBundle = '';
let bundleDirectory = '';

beforeAll(async () => {
  bundleDirectory = await mkdtemp(path.join(tmpdir(), 'home-crash-bundle-'));
  workerBundle = path.join(bundleDirectory, 'crash-worker.cjs');
  await build({
    entryPoints: [path.resolve('tests/crash-worker.ts')],
    outfile: workerBundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  });
});
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
afterAll(async () => { await rm(bundleDirectory, { recursive: true, force: true }); await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function directory(): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), 'home-project-'));
  directories.push(value);
  return value;
}
function open(file: string, initial: Project = createSample()): ProjectStore {
  const store = new ProjectStore(file, initial, validateGeometry);
  stores.push(store);
  return store;
}
function semantic(project: Project): string {
  return canonicalJson({ ...project, revision: 0 });
}
function rename(revision: number, name: string, requestId = name): Transaction {
  return { requestId, baseRevision: revision, label: 'Rename', source: 'user', commands: [{ type: 'rename', name }] };
}
function messageFrom(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('crash worker timed out')), 15000);
    let settled = false;
    child.on('message', message => { if (!settled) { settled = true; clearTimeout(timer); resolve(String(message)); } });
    child.on('exit', code => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`crash worker exited early (${code})`)); } });
  });
}
async function killed(mode: string, db: string): Promise<void> {
  const child = fork(workerBundle, [mode, db], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  try {
    await messageFrom(child);
    child.kill('SIGKILL');
    await new Promise(resolve => child.once('exit', resolve));
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
}

describe('project transactions', () => {
  it('matches the memory preview, undo, and a retried request', async () => {
    const dir = await directory();
    const durable = open(path.join(dir, 'project.sqlite'));
    const preview = new MemoryStore(createSample(), validateGeometry);
    const same = () => {
      expect(canonicalJson(durable.getState().project)).toBe(canonicalJson(preview.getState().project));
      expect(durable.getState().canUndo).toBe(preview.getState().canUndo);
      expect(durable.getState().canRedo).toBe(preview.getState().canRedo);
    };
    same();
    const first = rename(0, 'North studio', 'same-request');
    durable.transact(first); preview.transact(first); same();
    durable.transact(first); preview.transact(first); same();
    expect(durable.getState().project.revision).toBe(1);
    durable.undo(1); preview.undo(1); same();
    durable.transact(first); preview.transact(first); same();
    expect(durable.getState().project.name).toBe('Split-level studio');
    const second = rename(2, 'East studio', 'same-request');
    expect(() => durable.transact(second)).toThrow(/already used/);
    expect(() => preview.transact(second)).toThrow(/already used/);
    expect(() => durable.transact(rename(0, 'Stale', 'fresh'))).toThrow(/refresh the proposal/);
    same();
  });

  it('replays 100 mixed edits without semantic drift', async () => {
    const dir = await directory();
    const store = open(path.join(dir, 'project.sqlite'));
    const original = semantic(store.getState().project);
    for (let i = 0; i < 100; i++) {
      const project = store.getState().project;
      const kind = i % 4;
      const tx: Transaction = { requestId: `mix-${i}`, baseRevision: project.revision, label: `Edit ${i}`, source: 'user', commands: [] };
      if (kind === 0) {
        const south = project.walls.find(item => item.id === 'south')!;
        tx.commands = [{ type: 'put', collection: 'walls', entity: { ...south, height: 2.7 + (i % 6) * 0.01 } }];
      } else if (kind === 1) {
        const platform = project.slabs.find(item => item.id === 'platform')!;
        tx.commands = [{ type: 'put', collection: 'slabs', entity: { ...platform, elevation: 0.6 + (i % 5) * 0.02 } }];
      } else if (kind === 2) {
        const roof = project.roofs[0]!;
        tx.commands = [{ type: 'put', collection: 'roofs', entity: { ...roof, pitchRight: 30 + (i % 5) } }];
      } else tx.commands = [{ type: 'rename', name: `House ${i}` }];
      store.transact(tx);
    }
    const edited = semantic(store.getState().project);
    for (let i = 0; i < 100; i++) store.undo(store.getState().project.revision);
    expect(semantic(store.getState().project)).toBe(original);
    for (let i = 0; i < 100; i++) store.redo(store.getState().project.revision);
    expect(semantic(store.getState().project)).toBe(edited);
  });

  it('moves anchored furniture by the slab change and rejects locked or out-of-scope edits', async () => {
    const dir = await directory();
    const store = open(path.join(dir, 'project.sqlite'));
    const before = store.getState().project;
    const anchored = before.instances.find(item => item.slabId === 'platform')!;
    const loose = before.instances.find(item => item.slabId === 'floor')!;
    const platform = before.slabs.find(item => item.id === 'platform')!;
    store.transact({
      requestId: 'raise', baseRevision: 0, label: 'Raise platform', source: 'user',
      commands: [{ type: 'put', collection: 'slabs', entity: { ...platform, elevation: platform.elevation + 0.6 } }],
    });
    const after = store.getState().project;
    expect(after.instances.find(item => item.id === anchored.id)!.y).toBe(anchored.y);
    expect(instanceWorldPose(after, after.instances.find(item => item.id === anchored.id)!).y - instanceWorldPose(before, anchored).y).toBeCloseTo(0.6, 8);
    expect(instanceWorldPose(after, after.instances.find(item => item.id === loose.id)!).y).toBe(instanceWorldPose(before, loose).y);

    store.transact({
      requestId: 'lock', baseRevision: after.revision, label: 'Lock length', source: 'user',
      commands: [{ type: 'put', collection: 'measurements', entity: { id: 'len', entityId: 'south', property: 'length', value: 8, locked: true, origin: 'measured' } }],
    });
    const locked = store.getState();
    const end = locked.project.nodes.find(item => item.id === 'se')!;
    expect(() => store.transact({
      requestId: 'stretch', baseRevision: locked.project.revision, label: 'Stretch', source: 'user',
      commands: [{ type: 'rename', name: 'Should not stick' }, { type: 'put', collection: 'nodes', entity: { ...end, x: 8.4 } }],
    })).toThrow(/Locked length/);
    expect(store.getState().project.name).toBe(locked.project.name);
    expect(store.getState().project.revision).toBe(locked.project.revision);

    const tiny = store.getState().project;
    expect(() => store.transact({
      requestId: 'ai-height', baseRevision: tiny.revision, label: 'AI height', source: 'ai', allowedIds: ['south'],
      commands: [{ type: 'put', collection: 'walls', entity: { ...tiny.walls.find(item => item.id === 'south')!, height: 3 } }],
    })).toThrow(/outside the authorized scope/);
    expect(() => store.transact({
      requestId: 'ai-measure', baseRevision: tiny.revision, label: 'AI measure', source: 'ai', allowedIds: ['guess'],
      commands: [{ type: 'put', collection: 'measurements', entity: { id: 'guess', entityId: 'south', property: 'height', value: 3, locked: false, origin: 'measured' } }],
    })).toThrow(/inferred and unlocked/);
  });

  it('rejects a shared-wall AI edit unless the neighbouring wall is in scope', async () => {
    const dir = await directory();
    const initial: Project = {
      ...createSample(), name: 'Scope', walls: [
        { id: 'left', name: 'Left', start: 'a', end: 'b', thickness: 0.2, base: 0, height: 2.7, color: '#dddddd' },
        { id: 'right', name: 'Right', start: 'b', end: 'c', thickness: 0.2, base: 0, height: 2.7, color: '#dddddd' },
        { id: 'far', name: 'Far', start: 'd', end: 'e', thickness: 0.2, base: 0, height: 2.7, color: '#dddddd' },
      ],
      nodes: [{ id: 'a', x: 0, z: 0 }, { id: 'b', x: 4, z: 0 }, { id: 'c', x: 4, z: 3 }, { id: 'd', x: 0, z: 5 }, { id: 'e', x: 2, z: 5 }],
      openings: [], slabs: [], roofs: [], beams: [], instances: [],
    };
    const store = open(path.join(dir, 'scope.sqlite'), initial);
    const left = store.getState().project.walls.find(item => item.id === 'left')!;
    expect(() => store.transact({
      requestId: 'narrow', baseRevision: 0, label: 'Narrow scope', source: 'ai', allowedIds: ['left'],
      commands: [{ type: 'put', collection: 'walls', entity: { ...left, height: 3 } }],
    })).toThrow(/right/);
    store.transact({
      requestId: 'wide', baseRevision: 0, label: 'Shared scope', source: 'ai', allowedIds: ['left', 'right'],
      commands: [{ type: 'put', collection: 'walls', entity: { ...left, height: 3 } }],
    });
    expect(store.getState().project.walls.find(item => item.id === 'far')!.height).toBe(2.7);
    expect(store.getState().project.walls.find(item => item.id === 'left')!.height).toBe(3);
  });
});

describe('durability', () => {
  it('reopens the committed project and keeps a failed commit off disk', async () => {
    const dir = await directory();
    const file = path.join(dir, 'project.sqlite');
    const first = open(file);
    expect(first.durability()).toEqual({ journalMode: 'wal', synchronous: 2 });
    first.transact(rename(0, 'Saved room', 'save'));
    first.close();
    stores.pop();
    const reopened = open(file, { ...createSample(), name: 'Do not replace' });
    expect(reopened.getState().project.name).toBe('Saved room');
    reopened.undo(reopened.getState().project.revision);
    expect(reopened.getState().project.name).toBe('Split-level studio');
    reopened.close();
    stores.pop();

    let attempts = 0;
    const guarded = new ProjectStore(file, createSample(), validateGeometry, {
      beforeCommit() { attempts += 1; if (attempts === 1) throw new Error('disk full'); },
    });
    stores.push(guarded);
    const revision = guarded.getState().project.revision;
    expect(() => guarded.transact(rename(revision, 'Unsaved', 'unsaved'))).toThrow(/disk full/);
    expect(guarded.getState().project.revision).toBe(revision);
    expect(guarded.getState().project.name).not.toBe('Unsaved');
  });

  it('recovers a killed writer without publishing an uncommitted edit', async () => {
    const dir = await directory();
    const file = path.join(dir, 'project.sqlite');
    await killed('hold-open', file);
    expect(open(file).getState().project.name).toBe('Split-level studio');
    stores.at(-1)!.close(); stores.pop();

    const committed = path.join(dir, 'committed.sqlite');
    await killed('hold-committed', committed);
    expect(open(committed).getState().project.name).toBe('Committed');
    stores.at(-1)!.close(); stores.pop();

    const rolled = path.join(dir, 'rolled.sqlite');
    await killed('hang-before', rolled);
    expect(open(rolled).getState().project.name).toBe('Split-level studio');
    stores.at(-1)!.close(); stores.pop();

    const durable = path.join(dir, 'after.sqlite');
    await killed('hang-after', durable);
    expect(open(durable).getState().project.name).toBe('Committed');
  });

  it('blocks a second writer and refuses an unknown database version', async () => {
    const dir = await directory();
    const file = path.join(dir, 'project.sqlite');
    open(file);
    const child = fork(workerBundle, ['try-open', file], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    await expect(messageFrom(child)).resolves.toMatch(/already open/);
    await new Promise(resolve => child.once('exit', resolve));

    stores.at(-1)!.close(); stores.pop();
    const raw = new DatabaseSync(file);
    raw.exec("UPDATE app_meta SET value='2' WHERE key='format'");
    raw.close();
    expect(() => open(file)).toThrow(/Unsupported project database version 2/);
    const check = new DatabaseSync(file, { readOnly: true });
    expect((check.prepare("SELECT value FROM app_meta WHERE key='format'").get() as { value: string }).value).toBe('2');
    check.close();
  });

  it('migrates a project document that predates schemaVersion and leaves a newer schema untouched', async () => {
    const dir = await directory();
    const file = path.join(dir, 'project.sqlite');
    open(file).close();
    stores.pop();
    const raw = new DatabaseSync(file);
    const row = raw.prepare('SELECT project FROM project_state WHERE id=1').get() as { project: string };
    const { schemaVersion: _version, ...legacy } = JSON.parse(row.project) as Project;
    raw.prepare('UPDATE project_state SET project=? WHERE id=1').run(JSON.stringify(legacy));
    raw.close();
    const migrated = open(file);
    expect(migrated.getState().project.schemaVersion).toBe(1);
    expect(migrated.getState().project.name).toBe('Split-level studio');
    migrated.close();
    stores.pop();
    const stored = new DatabaseSync(file, { readOnly: true });
    const saved = JSON.parse((stored.prepare('SELECT project FROM project_state WHERE id=1').get() as { project: string }).project) as Project;
    expect(saved.schemaVersion).toBe(1);
    stored.close();

    const future = new DatabaseSync(file);
    const current = JSON.parse((future.prepare('SELECT project FROM project_state WHERE id=1').get() as { project: string }).project) as Project;
    future.prepare('UPDATE project_state SET project=? WHERE id=1').run(JSON.stringify({ ...current, schemaVersion: 2 }));
    future.close();
    expect(() => open(file)).toThrow(/Unsupported project schema version 2/);
    const unchanged = new DatabaseSync(file, { readOnly: true });
    const after = JSON.parse((unchanged.prepare('SELECT project FROM project_state WHERE id=1').get() as { project: string }).project) as { schemaVersion: number };
    expect(after.schemaVersion).toBe(2);
    unchanged.close();
  });

  it('exports a project snapshot that survives deletion of the source assets', async () => {
    const dir = await directory();
    const hash = createHash('sha256').update('marker').digest('hex');
    const assetDir = path.join(dir, 'library');
    await mkdir(assetDir, { recursive: true });
    await writeFile(path.join(assetDir, `${hash}.glb`), 'glb-bytes');
    await writeFile(path.join(assetDir, `${hash}.json`), '{"license":"test"}');
    const file = path.join(dir, 'project.sqlite');
    const store = open(file);
    const asset = { id: 'marker', name: 'Marker', kind: 'glb' as const, width: 1, height: 1, depth: 1, color: '#cccccc', file: `${hash}.glb`, license: 'test', aiAllowed: false };
    store.transact({ requestId: 'asset', baseRevision: 0, label: 'Add asset', source: 'user', commands: [{ type: 'put', collection: 'assets', entity: asset }] });
    const destination = path.join(dir, 'export.homeproject');
    await exportProjectBundle(store, assetDir, destination);
    await rm(assetDir, { recursive: true, force: true });
    expect(await readFile(path.join(destination, 'assets', `${hash}.glb`), 'utf8')).toBe('glb-bytes');
    expect(await readFile(path.join(destination, 'assets', `${hash}.json`), 'utf8')).toContain('test');
    const exported = JSON.parse(await readFile(path.join(destination, 'project.json'), 'utf8'));
    expect(exported.name).toBe('Split-level studio');
    const copy = open(path.join(destination, 'project.sqlite'));
    expect(copy.getState().project.assets.some(item => item.file === `${hash}.glb`)).toBe(true);
    expect(existsSync(file)).toBe(true);
    await expect(exportProjectBundle(store, assetDir, destination)).rejects.toThrow(/already exists/);
  });
});
