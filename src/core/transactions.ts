import type { Collection, Entity, Project, Transaction } from '../shared/model';
import { collections, CoreError } from './schema';

function entityMap(project: Project): Map<string, Entity> {
  return new Map(collections.flatMap(c => project[c].map(e => [e.id, e] as const)));
}

/** Includes derived dependents and neighbouring junction walls, using both old and new topology. */
export function affectedEntityIds(before: Project, after: Project, changed: Set<string>): Set<string> {
  const affected = new Set(changed);
  const causalWalls = new Set<string>();
  for (const p of [before, after]) {
    for (const wall of p.walls) {
      if (changed.has(wall.id) || changed.has(wall.start) || changed.has(wall.end) || (wall.roofId && changed.has(wall.roofId)) || (wall.storeyId && changed.has(wall.storeyId))) causalWalls.add(wall.id);
    }
  }
  for (const p of [before, after]) {
    const junctions = new Set(p.walls.filter(w => causalWalls.has(w.id)).flatMap(w => [w.start, w.end]));
    for (const wall of p.walls) if (causalWalls.has(wall.id) || junctions.has(wall.start) || junctions.has(wall.end)) affected.add(wall.id);
    for (const slab of p.slabs) if (slab.storeyId && changed.has(slab.storeyId)) affected.add(slab.id);
  }
  for (const p of [before, after]) {
    for (const opening of p.openings) if (affected.has(opening.wallId)) affected.add(opening.id);
    for (const instance of p.instances) if (affected.has(instance.assetId) || (instance.slabId && affected.has(instance.slabId))) affected.add(instance.id);
    for (const m of p.measurements) if (affected.has(m.entityId)) affected.add(m.id);
  }
  return affected;
}

export function applyCommands(before: Project, tx: Transaction): Project {
  const next = structuredClone(before);
  const changed = new Set<string>();
  const oldEntities = entityMap(before);
  for (const command of tx.commands) {
    if (command.type === 'rename') {
      if (tx.source === 'ai') throw new CoreError('OUT_OF_SCOPE', 'AI room edits cannot rename the whole project.');
      next.name = command.name;
      continue;
    }
    const id = command.type === 'put' ? command.entity.id : command.id;
    changed.add(id);
    if (tx.source === 'ai') {
      if (command.collection === 'assets') throw new CoreError('AI_ASSET_POLICY', 'AI may place known assets but cannot change catalog files or AI-use permissions.');
      if (command.collection === 'measurements') {
        const old = before.measurements.find(m => m.id === id);
        if (old && (old.origin !== 'inferred' || old.locked)) throw new CoreError('AI_PROVENANCE', 'AI cannot replace or remove authoritative or locked measurements.');
        if (command.type === 'put') {
          const value = command.entity as Project['measurements'][number];
          if (value.origin !== 'inferred' || value.locked) throw new CoreError('AI_PROVENANCE', 'AI-created measurements must be inferred and unlocked.');
        }
      }
    }
    const list = next[command.collection] as Entity[];
    const index = list.findIndex(e => e.id === id);
    if (command.type === 'remove') {
      if (index === -1) throw new CoreError('UNKNOWN_ENTITY', `Cannot remove missing ${command.collection} entity ${id}.`);
      list.splice(index, 1);
    } else {
      // An ID cannot change collections through replacement.
      if (index === -1 && oldEntities.has(id)) throw new CoreError('DUPLICATE_ID', `${id} belongs to another entity collection.`);
      if (index === -1) list.push(structuredClone(command.entity)); else list[index] = structuredClone(command.entity);
    }
  }
  // Anchored instance.y is a slab-relative offset. Rendering derives worldY,
  // so raising a slab affects those instances without rewriting their offsets.
  if (tx.source === 'ai') {
    if (!tx.allowedIds || tx.allowedIds.length === 0) throw new CoreError('OUT_OF_SCOPE', 'An AI edit requires an explicit host-authorized entity scope.');
    const scope = new Set(tx.allowedIds);
    const denied = [...affectedEntityIds(before, next, changed)].filter(id => !scope.has(id));
    if (denied.length) throw new CoreError('OUT_OF_SCOPE', `Edit also affects entities outside the authorized scope: ${denied.slice(0, 12).join(', ')}.`);
  }
  next.revision = before.revision + 1;
  return next;
}
