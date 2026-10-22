import type { Project, Transaction } from '../shared/model';
import type { RoomBrief, RoomSide } from './room-brief';

export interface LockedDimension {
  property: 'width' | 'depth' | 'height' | 'floorElevation';
  valueM: number;
}

const SIDES: RoomSide[] = ['south', 'east', 'north', 'west'];

export function roomSlug(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return slug || 'room';
}

/** A locked tape measurement replaces the brief. The replacement is reported, not hidden. */
export function reconcileBrief(brief: RoomBrief, locked: LockedDimension[]): { brief: RoomBrief; overridden: string[] } {
  const next = structuredClone(brief);
  const overridden: string[] = [];
  for (const lock of locked) {
    const current = next[lock.property];
    if (Math.abs(current - lock.valueM) > 1e-6) {
      next[lock.property] = lock.valueM;
      overridden.push(lock.property);
    }
  }
  return { brief: next, overridden };
}

export function emptyRoomProject(): Project {
  return {
    schemaVersion: 1, revision: 0, name: 'Untitled room',
    nodes: [], storeys: [], walls: [], openings: [], slabs: [], roofs: [], beams: [],
    assets: [], instances: [], measurements: [],
  };
}

/** Expands a rectangular room brief into the editor's existing put commands. */
export function roomTransaction(brief: RoomBrief, baseRevision = 0): Transaction {
  const id = roomSlug(brief.name);
  const { width, depth, height, floorElevation, wallThickness } = brief;
  const nodes = {
    sw: { id: `${id}-sw`, x: 0, z: 0 },
    se: { id: `${id}-se`, x: width, z: 0 },
    ne: { id: `${id}-ne`, x: width, z: depth },
    nw: { id: `${id}-nw`, x: 0, z: depth },
  };
  const walls = [
    { id: `${id}-south`, name: `${brief.name} south`, start: nodes.sw.id, end: nodes.se.id },
    { id: `${id}-east`, name: `${brief.name} east`, start: nodes.se.id, end: nodes.ne.id },
    { id: `${id}-north`, name: `${brief.name} north`, start: nodes.ne.id, end: nodes.nw.id },
    { id: `${id}-west`, name: `${brief.name} west`, start: nodes.nw.id, end: nodes.sw.id },
  ].map(wall => ({
    ...wall, thickness: wallThickness, base: floorElevation, height, color: '#c4b8a8', storeyId: `${id}-storey`,
  }));
  const openings = brief.openings.map((opening, index) => ({
    id: `${id}-opening-${index + 1}`,
    wallId: `${id}-${opening.wall}`,
    kind: opening.kind,
    offset: opening.offset,
    width: opening.width,
    sill: opening.sill,
    height: opening.height,
  }));
  const measurements = [
    { id: `${id}-width`, entityId: `${id}-south`, property: 'length', value: width },
    { id: `${id}-depth`, entityId: `${id}-east`, property: 'length', value: depth },
    { id: `${id}-height`, entityId: `${id}-south`, property: 'height', value: height },
  ].map(item => ({ ...item, locked: false, origin: 'inferred' as const }));
  const commands: Transaction['commands'] = [
    { type: 'put', collection: 'storeys', entity: { id: `${id}-storey`, name: brief.name, elevation: floorElevation } },
    ...Object.values(nodes).map(entity => ({ type: 'put' as const, collection: 'nodes' as const, entity })),
    ...walls.map(entity => ({ type: 'put' as const, collection: 'walls' as const, entity })),
    ...openings.map(entity => ({ type: 'put' as const, collection: 'openings' as const, entity })),
    { type: 'put', collection: 'slabs', entity: {
      id: `${id}-floor`, name: brief.name, elevation: floorElevation, thickness: 0.2, color: '#c9b48a', storeyId: `${id}-storey`,
      polygon: [nodes.sw, nodes.se, nodes.ne, nodes.nw].map(({ x, z }) => ({ x, z })), holes: [],
    } },
    ...measurements.map(entity => ({ type: 'put' as const, collection: 'measurements' as const, entity })),
  ];
  return {
    requestId: `draft-${id}`,
    baseRevision,
    label: `Draft ${brief.name}`,
    source: 'ai',
    allowedIds: commands.flatMap(command => command.type === 'put' ? [command.entity.id] : []),
    commands,
  };
}

export function sideOfWall(wallId: string): RoomSide | undefined {
  return SIDES.find(side => wallId.endsWith(`-${side}`));
}
