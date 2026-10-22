import { measurementValue } from '../core/schema';
import type { Beam, Opening, Point2, Project, Slab, Wall } from '../shared/model';
import { formatPlanFeet } from '../units';

export interface PlanLabel { x: number; z: number; text: string }

function freshId(project: Project, stem: string): string {
  const used = new Set<string>();
  for (const collection of ['nodes', 'storeys', 'walls', 'openings', 'slabs', 'roofs', 'beams', 'assets', 'instances', 'measurements'] as const) {
    for (const entity of project[collection]) used.add(entity.id);
  }
  let index = 1;
  while (used.has(`${stem}-${index}`)) index += 1;
  return `${stem}-${index}`;
}

function inside(point: Point2, polygon: Point2[]): boolean {
  let contained = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const current = polygon[index]!;
    const prior = polygon[previous]!;
    if ((current.z > point.z) !== (prior.z > point.z) && point.x < ((prior.x - current.x) * (point.z - current.z)) / (prior.z - current.z) + current.x) contained = !contained;
  }
  return contained;
}

export function outwardNormal(project: Project, wall: Wall): { x: number; z: number } | undefined {
  const start = project.nodes.find(node => node.id === wall.start);
  const end = project.nodes.find(node => node.id === wall.end);
  if (!start || !end) return undefined;
  const length = Math.hypot(end.x - start.x, end.z - start.z);
  if (length < 0.05) return undefined;
  const dx = (end.x - start.x) / length;
  const dz = (end.z - start.z) / length;
  let x = dz;
  let z = -dx;
  const slabs = project.slabs.filter(slab => slab.storeyId === wall.storeyId && slab.polygon.length > 0);
  if (slabs.length) {
    let cx = 0;
    let cz = 0;
    let count = 0;
    for (const slab of slabs) for (const point of slab.polygon) { cx += point.x; cz += point.z; count += 1; }
    const midX = (start.x + end.x) / 2;
    const midZ = (start.z + end.z) / 2;
    if ((cx / count - midX) * x + (cz / count - midZ) * z > 0) { x = -x; z = -z; }
  }
  return { x, z };
}

/** A door or window in the first gap that can hold it. */
export function placeOpening(project: Project, wall: Wall, kind: 'door' | 'window'): Opening | undefined {
  const length = measurementValue(project, wall.id, 'length') ?? 0;
  const width = Math.min(kind === 'door' ? 0.9 : 1.2, Math.max(0, length - 0.4));
  const height = Math.min(kind === 'door' ? 2.1 : 1.2, wall.height - (kind === 'door' ? 0.04 : 1.05));
  const sill = kind === 'door' ? 0 : Math.max(0, Math.min(0.9, wall.height - height - 0.04));
  if (width < 0.4 || height < 0.4) return undefined;
  const used = project.openings.filter(opening => opening.wallId === wall.id).sort((a, b) => a.offset - b.offset);
  const fits = (start: number) => start >= 0.02 && start + width <= length - 0.02 && used.every(opening => start + width <= opening.offset - 0.02 || start >= opening.offset + opening.width + 0.02);
  const candidates = [0.2, ...used.map(opening => opening.offset + opening.width + 0.08)];
  const offset = candidates.find(fits);
  if (offset === undefined) return undefined;
  return { id: freshId(project, `${wall.id}-${kind}`), wallId: wall.id, kind, offset, width, sill, height };
}

/** A timber hung on the underside, in the room below the slab when that room can be found. */
export function beamUnderSlab(project: Project, slab: Slab): Beam | undefined {
  const xs = slab.polygon.map(point => point.x);
  const zs = slab.polygon.map(point => point.z);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  const spanX = maxX - minX;
  const spanZ = maxZ - minZ;
  const inset = 0.15;
  const axis = spanX >= spanZ ? 'x' : 'z';
  const length = (axis === 'x' ? spanX : spanZ) - inset * 2;
  if (length < 0.2) return undefined;
  const centre = { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 };
  const underside = slab.elevation - slab.thickness;
  const below = project.slabs.filter(item => item.id !== slab.id && item.elevation < underside - 0.01 && inside(centre, item.polygon) && item.holes.every(hole => !inside(centre, hole)));
  const floor = below.sort((a, b) => b.elevation - a.elevation)[0];
  const siblings = project.beams.filter(beam => !beam.roofId && Math.abs(beam.elevation - underside) <= 1e-3 && inside(beam.axis === 'x' ? { x: beam.x + beam.length / 2, z: beam.z } : { x: beam.x, z: beam.z + beam.length / 2 }, slab.polygon));
  const slot = siblings.length + 1;
  const gaps = siblings.length + 2;
  return {
    id: freshId(project, `beam-${slab.id}`),
    name: `${slab.name} beam`,
    x: axis === 'x' ? minX + inset : minX + spanX * slot / gaps,
    z: axis === 'x' ? minZ + spanZ * slot / gaps : minZ + inset,
    length,
    width: 0.2,
    depth: 0.28,
    elevation: underside,
    axis,
    color: '#7a4f2c',
    storeyId: floor?.storeyId ?? slab.storeyId,
  };
}

function dimensionedWalls(project: Project, levelId: string): Wall[] {
  const walls = project.walls.filter(wall => wall.finish !== 'concrete');
  if (levelId) return walls.filter(wall => wall.storeyId === levelId);
  return walls.filter(wall => {
    const storey = project.storeys.find(item => item.id === wall.storeyId);
    return (storey?.elevation ?? wall.base) <= 1 && wall.base < 1;
  });
}

function keepApart(labels: PlanLabel[], gap: number): PlanLabel[] {
  const kept: PlanLabel[] = [];
  for (const label of labels) {
    if (kept.some(other => Math.hypot(other.x - label.x, other.z - label.z) < gap)) continue;
    kept.push(label);
  }
  return kept;
}

export function planLabels(project: Project, levelId: string): PlanLabel[] {
  const walls: PlanLabel[] = [];
  const openings: PlanLabel[] = [];
  for (const wall of dimensionedWalls(project, levelId)) {
    const start = project.nodes.find(node => node.id === wall.start);
    const end = project.nodes.find(node => node.id === wall.end);
    const normal = outwardNormal(project, wall);
    const length = measurementValue(project, wall.id, 'length');
    if (!start || !end || !normal || length === undefined || length < 1.2) continue;
    walls.push({
      x: (start.x + end.x) / 2 + normal.x * 1.05,
      z: (start.z + end.z) / 2 + normal.z * 1.05,
      text: formatPlanFeet(length),
    });
    for (const opening of project.openings.filter(item => item.wallId === wall.id && item.width >= 0.7)) {
      const distance = opening.offset + opening.width / 2;
      const alongX = (end.x - start.x) / length;
      const alongZ = (end.z - start.z) / length;
      openings.push({
        x: start.x + alongX * distance - normal.x * 0.42,
        z: start.z + alongZ * distance - normal.z * 0.42,
        text: formatPlanFeet(opening.width),
      });
    }
  }
  const beams = project.beams.filter(beam => {
    if (levelId) return beam.storeyId === levelId;
    const storey = project.storeys.find(item => item.id === beam.storeyId);
    return (storey?.elevation ?? 0) <= 1;
  });
  const spacing: PlanLabel[] = [];
  for (const axis of ['x', 'z'] as const) {
    const buckets = new Map<string, Beam[]>();
    for (const beam of beams.filter(item => item.axis === axis)) {
      const key = `${beam.storeyId ?? ''}:${beam.roofId ?? ''}:${Math.round(beam.elevation * 20)}`;
      buckets.set(key, [...(buckets.get(key) ?? []), beam]);
    }
    for (const group of buckets.values()) {
      group.sort((a, b) => axis === 'x' ? a.z - b.z : a.x - b.x);
      if (group.length < 2) continue;
      const left = group[0]!;
      const right = group[1]!;
      const leftStart = axis === 'x' ? left.x : left.z;
      const rightStart = axis === 'x' ? right.x : right.z;
      const overlap = Math.min(leftStart + left.length, rightStart + right.length) - Math.max(leftStart, rightStart);
      if (overlap < 0.4) continue;
      const span = axis === 'x' ? Math.abs(right.z - left.z) : Math.abs(right.x - left.x);
      if (span < 0.2) continue;
      const mid = group[Math.floor((group.length - 1) / 2)]!;
      const along = axis === 'x' ? mid.x + mid.length / 2 : mid.z + mid.length / 2;
      spacing.push(axis === 'x'
        ? { x: along, z: (left.z + right.z) / 2, text: formatPlanFeet(span) }
        : { x: (left.x + right.x) / 2, z: along, text: formatPlanFeet(span) });
    }
  }
  const placed = keepApart(walls, 1.3);
  const room = keepApart(openings.filter(label => placed.every(other => Math.hypot(other.x - label.x, other.z - label.z) >= 0.9)), 0.9);
  const gaps = keepApart(spacing.filter(label => [...placed, ...room].every(other => Math.hypot(other.x - label.x, other.z - label.z) >= 1.1)), 1.4);
  return [...placed, ...room, ...gaps];
}

export function openingAt(project: Project, wall: Wall, distance: number): string | undefined {
  return project.openings.find(opening => opening.wallId === wall.id && distance >= opening.offset && distance <= opening.offset + opening.width)?.id;
}
