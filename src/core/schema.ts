import { z } from 'zod';
import type { Collection, Diagnostic, Project, Transaction } from '../shared/model';

const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:-]+$/);
const name = z.string().trim().min(1).max(240);
const number = z.number().finite().min(-1e6).max(1e6);
const positive = z.number().finite().gt(0).max(1e5);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const point = z.strictObject({ x: number, z: number });
const polygon = z.array(point).min(3).max(2000);
const optionalText = z.string().max(4000).optional();

export const entitySchemas = {
  nodes: z.strictObject({ id, x: number, z: number }),
  storeys: z.strictObject({ id, name, elevation: number }),
  walls: z.strictObject({ id, name, start: id, end: id, thickness: positive, base: number, height: positive, color, roofId: id.optional(), storeyId: id.optional(), finish: z.enum(['siding', 'concrete']).optional(), interior: color.optional() }),
  openings: z.strictObject({ id, wallId: id, kind: z.enum(['door', 'window']), offset: number.nonnegative(), width: positive, sill: number.nonnegative(), height: positive }),
  slabs: z.strictObject({ id, name, polygon, holes: z.array(polygon).max(100), elevation: number, thickness: positive, color, storeyId: id.optional(), ceiling: z.enum(['planks']).optional() }),
  roofs: z.strictObject({ id, name, kind: z.enum(['gable', 'shed']), x: number, z: number, width: positive, depth: positive, eaveHeight: number, pitchLeft: z.number().finite().min(0).lt(89), pitchRight: z.number().finite().min(0).lt(89), thickness: positive, color }),
  beams: z.strictObject({ id, name, x: number, z: number, length: positive, width: positive, depth: positive, elevation: number, axis: z.enum(['x', 'z']), color, storeyId: id.optional(), roofId: id.optional() }),
  assets: z.strictObject({ id, name, kind: z.enum(['sofa', 'table', 'chair', 'plant', 'bed', 'cabinet', 'glb']), width: positive, height: positive, depth: positive, color, file: optionalText, thumbnail: optionalText, source: optionalText, author: optionalText, license: optionalText, aiAllowed: z.boolean() }),
  instances: z.strictObject({ id, name, assetId: id, x: number, y: number, z: number, rotation: number, scale: positive, slabId: id.optional() }),
  measurements: z.strictObject({ id, entityId: id, property: z.string().min(1).max(60).regex(/^[A-Za-z][A-Za-z0-9]*$/), value: number, locked: z.boolean(), origin: z.enum(['measured', 'chosen', 'inferred']) }),
} as const;

const collectionNames = Object.keys(entitySchemas) as [Collection, ...Collection[]];
export const collections: Collection[] = collectionNames;
const collectionSchema = z.enum(collectionNames);
export const projectSchema = z.strictObject({
  schemaVersion: z.literal(1), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), name,
  nodes: z.array(entitySchemas.nodes).max(10000), storeys: z.array(entitySchemas.storeys).max(100),
  walls: z.array(entitySchemas.walls).max(10000), openings: z.array(entitySchemas.openings).max(10000),
  slabs: z.array(entitySchemas.slabs).max(1000), roofs: z.array(entitySchemas.roofs).max(1000),
  beams: z.array(entitySchemas.beams).max(2000),
  assets: z.array(entitySchemas.assets).max(10000), instances: z.array(entitySchemas.instances).max(50000),
  measurements: z.array(entitySchemas.measurements).max(10000),
});

// A put is deliberately validated against its named collection, not just an Entity union.
const commandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('put'), collection: collectionSchema, entity: z.unknown() }),
  z.strictObject({ type: z.literal('remove'), collection: collectionSchema, id }),
  z.strictObject({ type: z.literal('rename'), name }),
]);
const txSchema = z.strictObject({
  requestId: id, baseRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), label: name,
  commands: z.array(commandSchema).min(1).max(500), source: z.enum(['user', 'ai']),
  allowedIds: z.array(id).max(50000).optional(),
});

export class CoreError extends Error {
  constructor(public readonly code: string, message: string, public readonly diagnostics: Diagnostic[] = []) {
    super(message); this.name = 'CoreError';
  }
}

function parse<T>(schema: z.ZodType, input: unknown, label: string): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new CoreError('INVALID_INPUT', `Invalid ${label}: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).slice(0, 8).join('; ')}`);
  return result.data as T;
}

function withBeams(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input) || 'beams' in input) return input;
  return { ...input, beams: [] };
}
export function parseProject(input: unknown): Project { return parse<Project>(projectSchema, withBeams(input), 'project'); }
export function parseTransaction(input: unknown): Transaction {
  const tx = parse<Transaction>(txSchema, input, 'transaction');
  tx.commands = tx.commands.map(command => command.type === 'put' ? {
    ...command, entity: parse(entitySchemas[command.collection], command.entity, `${command.collection} entity`),
  } : command);
  return tx;
}

/** Supported measurements are numeric own properties and computed straight-wall length. */
export function measurementValue(project: Project, entityId: string, property: string): number | undefined {
  const wall = project.walls.find(w => w.id === entityId);
  if (wall && property === 'length') {
    const start = project.nodes.find(n => n.id === wall.start), end = project.nodes.find(n => n.id === wall.end);
    return start && end ? Math.hypot(end.x - start.x, end.z - start.z) : undefined;
  }
  for (const collection of collections) {
    if (collection === 'measurements') continue;
    const entity = project[collection].find(e => e.id === entityId);
    if (entity && Object.hasOwn(entity, property)) {
      const value = (entity as unknown as Record<string, unknown>)[property];
      return typeof value === 'number' ? value : undefined;
    }
  }
  return undefined;
}

export function validateProject(project: Project): Diagnostic[] {
  const result = projectSchema.safeParse(project);
  if (!result.success) return result.error.issues.map(issue => ({ code: 'INVALID_INPUT', message: `${issue.path.join('.')}: ${issue.message}` }));
  const errors: Diagnostic[] = [];
  const all = new Set<string>();
  const ids = Object.fromEntries(collections.map(c => [c, new Set(project[c].map(e => e.id))])) as Record<Collection, Set<string>>;
  for (const collection of collections) for (const entity of project[collection]) {
    if (all.has(entity.id)) errors.push({ code: 'DUPLICATE_ID', entityId: entity.id, message: `ID ${entity.id} is not globally unique.` });
    all.add(entity.id);
  }
  const ref = (collection: Collection, target: string | undefined, entityId: string) => {
    if (target !== undefined && !ids[collection].has(target)) errors.push({ code: 'UNKNOWN_ENTITY', entityId, message: `${entityId} refers to missing ${collection} entity ${target}.` });
  };
  for (const w of project.walls) {
    ref('nodes', w.start, w.id); ref('nodes', w.end, w.id); ref('roofs', w.roofId, w.id); ref('storeys', w.storeyId, w.id);
    const length = measurementValue(project, w.id, 'length');
    if (length !== undefined && length < 1e-6) errors.push({ code: 'DEGENERATE_WALL', entityId: w.id, message: `${w.name} must have distinct endpoints.` });
  }
  for (const o of project.openings) {
    ref('walls', o.wallId, o.id);
    const wall = project.walls.find(w => w.id === o.wallId);
    const length = wall && measurementValue(project, wall.id, 'length');
    if (wall && ((length !== undefined && o.offset + o.width > length + 1e-8) || o.sill + o.height > wall.height + 1e-8)) errors.push({ code: 'OPENING_OUTSIDE_WALL', entityId: o.id, message: `${o.kind} ${o.id} extends outside its host wall.` });
  }
  for (const slab of project.slabs) ref('storeys', slab.storeyId, slab.id);
  for (const beam of project.beams) { ref('storeys', beam.storeyId, beam.id); ref('roofs', beam.roofId, beam.id); }
  for (const instance of project.instances) { ref('assets', instance.assetId, instance.id); ref('slabs', instance.slabId, instance.id); }
  for (const measurement of project.measurements) {
    const value = measurementValue(project, measurement.entityId, measurement.property);
    if (value === undefined) errors.push({ code: 'INVALID_MEASUREMENT', entityId: measurement.id, message: `Measurement ${measurement.id} does not refer to a supported numeric property.` });
    else if (measurement.locked && Math.abs(value - measurement.value) > 1e-8 * Math.max(1, Math.abs(value), Math.abs(measurement.value))) errors.push({ code: 'LOCKED_MEASUREMENT', entityId: measurement.entityId, message: `Locked ${measurement.property} on ${measurement.entityId} must remain ${measurement.value} m (or its native angular value).` });
  }
  return errors;
}
