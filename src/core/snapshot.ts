import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Project } from '../shared/model';
import { canonicalJson } from './canonical';
import { CoreError } from './schema';

export interface ProjectSnapshotSource {
  getState(): { project: Project };
  saveCopy(destinationPath: string): void;
}

async function durableWrite(file: string, contents: string): Promise<void> {
  const handle = await open(file, 'w');
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally { await handle.close(); }
}

/** Copy referenced asset files first, then the database, then publish the folder. */
export async function exportProjectBundle(store: ProjectSnapshotSource, assetsDirectory: string, destination: string): Promise<void> {
  const dest = path.resolve(destination);
  if (existsSync(dest)) throw new CoreError('DESTINATION_EXISTS', 'Export destination already exists.');
  const stage = `${dest}.tmp-${randomUUID()}`;
  await mkdir(path.join(stage, 'assets'), { recursive: true });
  try {
    const project = store.getState().project;
    const files = [...new Set(project.assets.map(asset => asset.file).filter((file): file is string => Boolean(file)))];
    for (const file of files) {
      if (!/^[a-f0-9]{64}\.glb$/.test(file)) throw new CoreError('UNSAFE_ASSET_PATH', `Refusing to export unsafe asset filename ${file}.`);
      await copyFile(path.join(assetsDirectory, file), path.join(stage, 'assets', file));
      const sidecar = file.replace(/\.glb$/, '.json');
      try { await copyFile(path.join(assetsDirectory, sidecar), path.join(stage, 'assets', sidecar)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    await durableWrite(path.join(stage, 'project.json'), canonicalJson(project));
    store.saveCopy(path.join(stage, 'project.sqlite'));
    await rename(stage, dest);
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}
