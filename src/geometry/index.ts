import earcut from 'earcut';
import type { Beam, Diagnostic, GeometryResult, MeshData, Opening, Point2, Project, Roof, Wall } from '../shared/model';

/** Numerical tolerance, distinct from UI snapping and real-world measurement accuracy. */
export const GEOMETRY_EPSILON = 1e-7;
/**
 * Joins closer than this are rejected. Offset-line mitres are kept; there is no silent bevel.
 * A mitre that inverts or overlaps a wall is also rejected, and the last valid model stays in place.
 * Shared mitre faces are left out of the meshes so joined walls meet without a double skin.
 */
export const MIN_JUNCTION_ANGLE_DEGREES = 15;
const E = GEOMETRY_EPSILON;
type V3 = [number, number, number];
type WallShape = { wall: Wall; a: Point2; b: Point2; length: number; dx: number; dz: number; polygon: Point2[] };
type Ray = { wall: Wall; angle: number; dx: number; dz: number; half: number };
const cross = (a: Point2, b: Point2, c: Point2) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
const same = (a: Point2, b: Point2) => Math.hypot(a.x - b.x, a.z - b.z) < E;
const finite = (...values: number[]) => values.every(Number.isFinite);
const pointAt = (a: Point2, b: Point2, t: number): Point2 => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
export const polygonArea = (p: Point2[]): number => p.reduce((sum, a, i) => { const b = p[(i + 1) % p.length]!; return sum + a.x * b.z - b.x * a.z; }, 0) / 2;
const clean = (p: Point2[]): Point2[] => p.filter((v, i) => !same(v, p[(i + p.length - 1) % p.length]!));
const ccw = (p: Point2[]): Point2[] => polygonArea(p) < 0 ? [...p].reverse() : [...p];
const onSegment = (p: Point2, a: Point2, b: Point2) => Math.abs(cross(a, b, p)) < E * Math.max(1, Math.hypot(b.x - a.x, b.z - a.z)) && p.x >= Math.min(a.x, b.x) - E && p.x <= Math.max(a.x, b.x) + E && p.z >= Math.min(a.z, b.z) - E && p.z <= Math.max(a.z, b.z) + E;
function intersects(a: Point2, b: Point2, c: Point2, d: Point2): boolean {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  return ((abC > E && abD < -E || abC < -E && abD > E) && (cdA > E && cdB < -E || cdA < -E && cdB > E)) || onSegment(a, c, d) || onSegment(b, c, d) || onSegment(c, a, b) || onSegment(d, a, b);
}
function simple(p: Point2[]): boolean {
  if (p.length < 3 || Math.abs(polygonArea(p)) < E) return false;
  for (let i = 0; i < p.length; i++) {
    if (same(p[i]!, p[(i + 1) % p.length]!)) return false;
    for (let j = i + 1; j < p.length; j++) {
      if (j === i + 1 || i === 0 && j === p.length - 1) continue;
      if (intersects(p[i]!, p[(i + 1) % p.length]!, p[j]!, p[(j + 1) % p.length]!)) return false;
    }
  }
  return true;
}
function pointInside(p: Point2, ring: Point2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if (onSegment(p, a, b)) return false; // strict containment for slab holes
    if ((a.z > p.z) !== (b.z > p.z) && p.x < (b.x - a.x) * (p.z - a.z) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}
function ringsIntersect(a: Point2[], b: Point2[]): boolean {
  return a.some((p, i) => b.some((q, j) => intersects(p, a[(i + 1) % a.length]!, q, b[(j + 1) % b.length]!)));
}

/** Clip a simple polygon by f(point)>=0. Our wall footprints are bounded to shapes
 * whose half-plane intersections remain a single polygon. */
function clip(p: Point2[], f: (v: Point2) => number): Point2[] {
  const out: Point2[] = [];
  for (let i = 0; i < p.length; i++) {
    const a = p[i]!, b = p[(i + 1) % p.length]!, fa = f(a), fb = f(b);
    if (fa >= -E) out.push(a);
    if (fa > E && fb < -E || fa < -E && fb > E) out.push(pointAt(a, b, fa / (fa - fb)));
  }
  return clean(out);
}

/** Eaves are fixed at equal heights. The two slopes meet at this unique ridge. */
export function roofRidgeX(roof: Roof): number {
  const l = Math.tan(roof.pitchLeft * Math.PI / 180), r = Math.tan(roof.pitchRight * Math.PI / 180);
  return roof.x + roof.width * r / (l + r);
}
/** Plan rectangle. x/z is the centre of the start end; length runs along axis. */
export function beamFootprint(beam: Beam): Point2[] {
  const half = beam.width / 2;
  return beam.axis === 'x'
    ? [{ x: beam.x, z: beam.z - half }, { x: beam.x + beam.length, z: beam.z - half }, { x: beam.x + beam.length, z: beam.z + half }, { x: beam.x, z: beam.z + half }]
    : [{ x: beam.x - half, z: beam.z }, { x: beam.x + half, z: beam.z }, { x: beam.x + half, z: beam.z + beam.length }, { x: beam.x - half, z: beam.z + beam.length }];
}
export function beamCeiling(project: Project, beam: Beam, at?: Point2): number {
  const point = at ?? (beam.axis === 'x' ? { x: beam.x + beam.length / 2, z: beam.z } : { x: beam.x, z: beam.z + beam.length / 2 });
  const roof = beam.roofId ? project.roofs.find(item => item.id === beam.roofId) : undefined;
  return roof ? roofHeightAt(roof, point.x, point.z) - roof.thickness : beam.elevation;
}

/** Top surface height; callers subtract thickness for the underside. */
export function roofHeightAt(roof: Roof, x: number, _z: number): number {
  const left = (x - roof.x) * Math.tan(roof.pitchLeft * Math.PI / 180);
  if (roof.kind === 'shed') return roof.eaveHeight + left;
  const right = (roof.x + roof.width - x) * Math.tan(roof.pitchRight * Math.PI / 180);
  return roof.eaveHeight + Math.min(left, right);
}

function raysAt(project: Project, nodeId: string, base: number): Ray[] {
  const nodes = new Map(project.nodes.map(n => [n.id, n]));
  return project.walls.filter(w => (w.start === nodeId || w.end === nodeId) && Math.abs(w.base - base) < E).flatMap(w => {
    const a = nodes.get(nodeId), b = nodes.get(w.start === nodeId ? w.end : w.start);
    if (!a || !b) return [];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < E) return [];
    const dx = (b.x - a.x) / len, dz = (b.z - a.z) / len;
    return [{ wall: w, dx, dz, half: w.thickness / 2, angle: Math.atan2(dz, dx) }];
  }).sort((a, b) => a.angle - b.angle);
}

/** Offset-line intersection in the sector from first to second, CCW.
 * Opposite rays use their own offset point (a thickness step is supported). */
function sectorCorner(node: Point2, first: Ray, second: Ray, owner: Ray): Point2 {
  const det = first.dx * second.dz - first.dz * second.dx;
  if (Math.abs(det) < E) {
    const sign = owner === first ? 1 : -1;
    return { x: node.x - owner.dz * owner.half * sign, z: node.z + owner.dx * owner.half * sign };
  }
  const p = { x: -first.dz * first.half, z: first.dx * first.half };
  const q = { x: second.dz * second.half, z: -second.dx * second.half };
  const t = ((q.x - p.x) * second.dz - (q.z - p.z) * second.dx) / det;
  return { x: node.x + p.x + first.dx * t, z: node.z + p.z + first.dz * t };
}

function endCap(project: Project, wall: Wall, nodeId: string): Point2[] {
  const node = project.nodes.find(n => n.id === nodeId)!;
  const rays = raysAt(project, nodeId, wall.base), i = rays.findIndex(r => r.wall.id === wall.id), ray = rays[i]!;
  if (rays.length === 1) return [{ x: node.x + ray.dz * ray.half, z: node.z - ray.dx * ray.half }, { x: node.x - ray.dz * ray.half, z: node.z + ray.dx * ray.half }];
  const right = sectorCorner(node, rays[(i + rays.length - 1) % rays.length]!, ray, ray);
  const left = sectorCorner(node, ray, rays[(i + 1) % rays.length]!, ray);
  return [right, node, left];
}
function wallShape(project: Project, wall: Wall): WallShape {
  const a = project.nodes.find(n => n.id === wall.start)!, b = project.nodes.find(n => n.id === wall.end)!;
  const length = Math.hypot(b.x - a.x, b.z - a.z), dx = (b.x - a.x) / length, dz = (b.z - a.z) / length;
  // Both caps use outward rays; start-right -> start-left -> end-right -> end-left.
  const polygon = ccw(clean([...endCap(project, wall, wall.start), ...endCap(project, wall, wall.end)]));
  return { wall, a, b, length, dx, dz, polygon };
}
/** Interior edges where this wall's mitre meets its neighbours. Free butt ends are not included. */
function junctionEdges(project: Project, wall: Wall): Array<[Point2, Point2]> {
  const edges: Array<[Point2, Point2]> = [];
  for (const nodeId of [wall.start, wall.end]) {
    if (raysAt(project, nodeId, wall.base).length < 2) continue;
    const cap = endCap(project, wall, nodeId);
    for (let i = 0; i < cap.length - 1; i++) edges.push([cap[i]!, cap[i + 1]!]);
  }
  return edges;
}
function onJunctionEdge(a: Point2, b: Point2, edges: Array<[Point2, Point2]>): boolean {
  return edges.some(([c, d]) => onSegment(a, c, d) && onSegment(b, c, d));
}
const localU = (s: WallShape, p: Point2) => (p.x - s.a.x) * s.dx + (p.z - s.a.z) * s.dz;
const localPoint = (s: WallShape, u: number, v: number): Point2 => ({ x: s.a.x + s.dx * u - s.dz * v, z: s.a.z + s.dz * u + s.dx * v });
function topAt(project: Project, wall: Wall, p: Point2): number {
  const roof = project.roofs.find(r => r.id === wall.roofId);
  return roof ? roofHeightAt(roof, p.x, p.z) - roof.thickness : wall.base + wall.height;
}

function triPoints(rings: Point2[][]): Point2[][] {
  const points = rings.flat(), holes: number[] = [];
  let offset = rings[0]!.length;
  for (const ring of rings.slice(1)) { holes.push(offset); offset += ring.length; }
  const indices = earcut(points.flatMap(p => [p.x, p.z]), holes, 2);
  let triangles: Point2[][] = [];
  for (let i = 0; i < indices.length; i += 3) triangles.push([points[indices[i]!]!, points[indices[i + 1]!]!, points[indices[i + 2]!]!]);
  // Earcut removes collinear boundary points. Restore them so side boundaries
  // share all top/bottom vertices and the geometric mesh has no T-junctions.
  for (const p of points) {
    const next: Point2[][] = [];
    for (const tri of triangles) {
      let split = false;
      for (let i = 0; i < 3; i++) {
        const a = tri[i]!, b = tri[(i + 1) % 3]!, c = tri[(i + 2) % 3]!;
        if (!same(a, p) && !same(b, p) && onSegment(p, a, b)) { next.push([a, p, c], [p, b, c]); split = true; break; }
      }
      if (!split) next.push(tri);
    }
    triangles = next;
  }
  return triangles.filter(t => Math.abs(cross(t[0]!, t[1]!, t[2]!)) > E * E);
}
function triangleOverlap(a: Point2[], b: Point2[]): number {
  let p = a;
  const boundary = ccw(b);
  for (let i = 0; i < boundary.length; i++) p = clip(p, v => cross(boundary[i]!, boundary[(i + 1) % boundary.length]!, v));
  return p.length >= 3 ? Math.abs(polygonArea(p)) : 0;
}
function overlapArea(a: Point2[], b: Point2[]): number {
  const aa = triPoints([a]), bb = triPoints([b]);
  return aa.reduce((sum, ta) => sum + bb.reduce((sub, tb) => sub + triangleOverlap(ta, tb), 0), 0);
}

export function validateGeometry(project: Project): Diagnostic[] {
  const errors: Diagnostic[] = [];
  const fail = (code: string, entityId: string, message: string) => errors.push({ code, entityId, message });
  for (const n of project.nodes) if (!finite(n.x, n.z) || Math.abs(n.x) > 10000 || Math.abs(n.z) > 10000) fail('INVALID_NODE', n.id, 'Node coordinates must be finite and within 10 km of the origin.');
  for (const r of project.roofs) {
    if (!finite(r.x, r.z, r.width, r.depth, r.eaveHeight, r.pitchLeft, r.pitchRight, r.thickness) || r.width < 0.05 || r.depth < 0.05 || r.thickness <= 0 || r.pitchLeft < (r.kind === 'gable' ? 1 : 0) || r.pitchLeft > 80 || r.kind === 'gable' && (r.pitchRight < 1 || r.pitchRight > 80)) fail('INVALID_ROOF', r.id, 'Roof dimensions must be positive; shed pitch is 0–80°, and gable pitches are 1–80°.');
  }
  for (const beam of project.beams) {
    if (!finite(beam.x, beam.z, beam.length, beam.width, beam.depth, beam.elevation) || beam.length < 0.2 || beam.width < 0.04 || beam.width > 0.8 || beam.depth < 0.04 || beam.depth > 1) fail('INVALID_BEAM', beam.id, 'A beam needs a length of at least 20 cm, a width of 4–80 cm, and a depth of 4 cm–1 m.');
    if (beam.roofId && !project.roofs.some(roof => roof.id === beam.roofId)) fail('MISSING_ROOF', beam.id, 'The beam’s roof does not exist.');
  }
  for (const slab of project.slabs) {
    const rings = [slab.polygon, ...slab.holes];
    if (!finite(slab.elevation, slab.thickness) || slab.thickness <= 0 || rings.some(r => r.some(p => !finite(p.x, p.z)) || !simple(r))) { fail('INVALID_SLAB', slab.id, 'Slab rings must be simple finite polygons with positive thickness.'); continue; }
    for (let i = 0; i < slab.holes.length; i++) {
      const hole = slab.holes[i]!;
      if (!hole.every(p => pointInside(p, slab.polygon)) || ringsIntersect(hole, slab.polygon)) fail('INVALID_SLAB_HOLE', slab.id, 'A slab hole must lie strictly inside its outer boundary.');
      for (const other of slab.holes.slice(i + 1)) if (ringsIntersect(hole, other) || pointInside(hole[0]!, other) || pointInside(other[0]!, hole)) fail('INVALID_SLAB_HOLE', slab.id, 'Slab holes cannot touch, intersect, or contain one another.');
    }
  }
  if (!errors.length) {
    for (let i = 0; i < project.slabs.length; i++) {
      const lower = project.slabs[i]!;
      const lowerTris = triPoints([lower.polygon, ...lower.holes]);
      const lowerBottom = lower.elevation - lower.thickness;
      for (const upper of project.slabs.slice(i + 1)) {
        if (Math.min(lower.elevation, upper.elevation) - Math.max(lowerBottom, upper.elevation - upper.thickness) <= 1e-3) continue;
        let area = 0;
        for (const left of lowerTris) for (const right of triPoints([upper.polygon, ...upper.holes])) {
          area += triangleOverlap(left, right);
          if (area > 1e-4) break;
        }
        if (area > 1e-4) fail('SLAB_OVERLAP', upper.id, `${upper.name} occupies the same volume as ${lower.name}. Raise one slab, or place it in a hole.`);
      }
    }
  }
  for (const w of project.walls) {
    const a = project.nodes.find(n => n.id === w.start), b = project.nodes.find(n => n.id === w.end);
    if (!a || !b || !finite(w.thickness, w.base, w.height) || w.thickness < 0.02 || w.thickness > 2 || w.height < 0.02 || a && b && Math.hypot(a.x - b.x, a.z - b.z) < 0.02) fail('INVALID_WALL', w.id, 'Walls need valid distinct nodes, length/height ≥2 cm and thickness between 2 cm and 2 m.');
    if (w.roofId && !project.roofs.some(r => r.id === w.roofId)) fail('MISSING_ROOF', w.id, 'The attached roof does not exist.');
  }
  if (errors.length) return errors;
  const visited = new Set<string>();
  for (const w of project.walls) for (const id of [w.start, w.end]) {
    const key = `${id}:${w.base}`;
    if (visited.has(key)) continue;
    visited.add(key);
    const rays = raysAt(project, id, w.base);
    if (rays.length > 4) fail('JUNCTION_DEGREE', id, 'This prototype supports at most four walls at a junction.');
    if (rays.length > 1) for (let i = 0; i < rays.length; i++) {
      const gap = ((rays[(i + 1) % rays.length]!.angle - rays[i]!.angle + Math.PI * 2) % (Math.PI * 2)) * 180 / Math.PI;
      if (gap < MIN_JUNCTION_ANGLE_DEGREES - E) fail('JUNCTION_ANGLE', id, 'Incident walls must be separated by at least 15°; duplicate directions are unsupported.');
    }
  }
  if (errors.length) return errors;
  const shapes = project.walls.map(w => wallShape(project, w));
  for (const s of shapes) {
    if (!simple(s.polygon)) { fail('WALL_FOOTPRINT', s.wall.id, 'Junction mitres overlap or invert this wall. Lengthen the wall or increase the angle.'); continue; }
    const roof = project.roofs.find(r => r.id === s.wall.roofId);
    if (roof && s.polygon.some(p => p.x < roof.x - E || p.x > roof.x + roof.width + E || p.z < roof.z - E || p.z > roof.z + roof.depth + E)) fail('WALL_OUTSIDE_ROOF', s.wall.id, 'The complete wall footprint must fit beneath its attached roof; enlarge the eaves.');
    if (s.polygon.some(p => topAt(project, s.wall, p) <= s.wall.base + E)) fail('WALL_TOP', s.wall.id, 'The wall top must remain above its base.');
    const capStart = endCap(project, s.wall, s.wall.start), capEnd = endCap(project, s.wall, s.wall.end);
    const minOpening = Math.max(0, ...capStart.map(p => localU(s, p))) + 0.01;
    const maxOpening = Math.min(s.length, ...capEnd.map(p => localU(s, p))) - 0.01;
    const openings = project.openings.filter(o => o.wallId === s.wall.id);
    for (const o of openings) {
      if (!finite(o.offset, o.width, o.height, o.sill) || o.width <= E || o.height <= E || o.sill < 0 || o.offset < minOpening - E || o.offset + o.width > maxOpening + E) { fail('OPENING_BOUNDS', o.id, 'Opening must have positive dimensions, a nonnegative sill and 1 cm clearance from both wall junctions.'); continue; }
      const corners = [localPoint(s, o.offset, -s.wall.thickness / 2), localPoint(s, o.offset, s.wall.thickness / 2), localPoint(s, o.offset + o.width, -s.wall.thickness / 2), localPoint(s, o.offset + o.width, s.wall.thickness / 2)];
      if (corners.some(p => s.wall.base + o.sill + o.height > topAt(project, s.wall, p) - 0.01 + E)) fail('OPENING_TOP', o.id, 'Opening must remain at least 1 cm below the wall or roof underside.');
    }
    for (let i = 0; i < openings.length; i++) for (const o of openings.slice(i + 1)) {
      const a = openings[i]!;
      // Bound the first implementation to one opening in each horizontal band.
      if (a.offset + a.width > o.offset - E && o.offset + o.width > a.offset - E) fail('OPENING_OVERLAP', o.id, 'Openings on one wall need disjoint horizontal spans, including vertically stacked openings.');
    }
  }
  for (const o of project.openings) if (!project.walls.some(w => w.id === o.wallId)) fail('MISSING_HOST', o.id, 'The opening host wall does not exist.');
  if (errors.length) return errors;
  for (let i = 0; i < shapes.length; i++) for (const b of shapes.slice(i + 1)) {
    const a = shapes[i]!;
    const topA = Math.max(...a.polygon.map(p => topAt(project, a.wall, p))), topB = Math.max(...b.polygon.map(p => topAt(project, b.wall, p)));
    if (Math.min(topA, topB) <= Math.max(a.wall.base, b.wall.base) + E) continue;
    const shared = [a.wall.start, a.wall.end].some(id => id === b.wall.start || id === b.wall.end);
    if (!shared && intersects(a.a, a.b, b.a, b.b)) { fail('UNCONNECTED_CROSSING', b.wall.id, `Wall crosses ${a.wall.name} without a shared node; split both walls at the junction.`); continue; }
    if (overlapArea(a.polygon, b.polygon) > 1e-8) fail('WALL_OVERLAP', b.wall.id, `Wall footprint overlaps ${a.wall.name}; use shared nodes at equal bases or separate the walls.`);
  }
  for (const beam of project.beams) {
    const footprint = beamFootprint(beam);
    const roof = beam.roofId ? project.roofs.find(item => item.id === beam.roofId) : undefined;
    if (roof && footprint.some(point => point.x < roof.x - E || point.x > roof.x + roof.width + E || point.z < roof.z - E || point.z > roof.z + roof.depth + E)) fail('BEAM_OUTSIDE_ROOF', beam.id, `${beam.name} must stay inside the roof it hangs from.`);
    const tops = footprint.map(point => beamCeiling(project, beam, point));
    const top = Math.max(...tops), bottom = Math.min(...tops) - beam.depth;
    for (const covering of project.roofs) {
      if (!footprint.every(point => point.x >= covering.x - E && point.x <= covering.x + covering.width + E && point.z >= covering.z - E && point.z <= covering.z + covering.depth + E)) continue;
      if (footprint.some(point => beamCeiling(project, beam, point) > roofHeightAt(covering, point.x, point.z) - covering.thickness + 1e-3)) fail('BEAM_THROUGH_ROOF', beam.id, `${beam.name} rises through ${covering.name}. Lower it, or hang it from that roof.`);
    }
    if (errors.some(item => item.entityId === beam.id)) continue;
    for (const slab of project.slabs) {
      const slabBottom = slab.elevation - slab.thickness;
      if (Math.min(top, slab.elevation) - Math.max(bottom, slabBottom) <= 1e-3) continue;
      if (overlapArea(footprint, slab.polygon) > 1e-4) fail('BEAM_OVERLAP', beam.id, `${beam.name} occupies the same volume as ${slab.name}.`);
    }
  }
  return errors;
}

class MeshBuilder {
  readonly positions: number[] = [];
  readonly indices: number[] = [];
  tri(a: V3, b: V3, c: V3, outward: V3): void {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [ab[1]! * ac[2]! - ab[2]! * ac[1]!, ab[2]! * ac[0]! - ab[0]! * ac[2]!, ab[0]! * ac[1]! - ab[1]! * ac[0]!];
    if (Math.hypot(...n) < E * E) return;
    const start = this.positions.length / 3;
    if (n[0]! * outward[0] + n[1]! * outward[1] + n[2]! * outward[2] < 0) [b, c] = [c, b];
    this.positions.push(...a, ...b, ...c); this.indices.push(start, start + 1, start + 2);
  }
  quad(a: V3, b: V3, c: V3, d: V3, outward: V3): void { this.tri(a, b, c, outward); this.tri(a, c, d, outward); }
  surface(rings: Point2[][], y: (p: Point2) => number, upward: boolean): void {
    for (const t of triPoints(rings)) this.tri([t[0]!.x, y(t[0]!), t[0]!.z], [t[1]!.x, y(t[1]!), t[1]!.z], [t[2]!.x, y(t[2]!), t[2]!.z], [0, upward ? 1 : -1, 0]);
  }
  vertical(a: Point2, b: Point2, lower: number, upperA: number, upperB: number, cutsA: number[] = [], cutsB: number[] = []): void {
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    const left = unique(cutsA).filter(y => y > lower + E && y < upperA - E);
    const right = unique(cutsB).filter(y => y > lower + E && y < upperB - E);
    const polygon = [{ x: 0, z: lower }, { x: length, z: lower }, ...right.map(y => ({ x: length, z: y })), { x: length, z: upperB }, { x: 0, z: upperA }, ...left.reverse().map(y => ({ x: 0, z: y }))];
    for (const t of triPoints([clean(polygon)])) {
      const v = t.map(p => { const q = pointAt(a, b, p.x / length); return [q.x, p.z, q.z] as V3; });
      this.tri(v[0]!, v[1]!, v[2]!, [b.z - a.z, 0, a.x - b.x]);
    }
  }
  data(id: string, kind: MeshData['kind'], color: string): MeshData { return { id, kind, color, positions: this.positions, indices: this.indices }; }
}

function splitRoof(polygon: Point2[], roof?: Roof): Point2[][] {
  if (!roof || roof.kind === 'shed') return [polygon];
  const ridge = roofRidgeX(roof);
  return [clip(polygon, p => ridge - p.x), clip(polygon, p => p.x - ridge)].filter(p => p.length >= 3 && Math.abs(polygonArea(p)) > E * E);
}
const unique = (values: number[]) => [...values].sort((a, b) => a - b).filter((v, i, array) => i === 0 || v - array[i - 1]! > E);
function wallMesh(project: Project, s: WallShape): MeshData {
  const m = new MeshBuilder(), w = s.wall, roof = project.roofs.find(r => r.id === w.roofId), openings = project.openings.filter(o => o.wallId === w.id);
  const seams = junctionEdges(project, w);
  const jambCuts = (u: number) => openings.flatMap(opening => Math.abs(u - opening.offset) <= 1e-6 || Math.abs(u - opening.offset - opening.width) <= 1e-6 ? [w.base + opening.sill, w.base + opening.sill + opening.height] : []);
  const us = s.polygon.map(p => localU(s, p));
  const cuts = unique([Math.min(...us), Math.max(...us), ...openings.flatMap(o => [o.offset, o.offset + o.width])]);
  for (let i = 0; i < cuts.length - 1; i++) {
    const low = cuts[i]!, high = cuts[i + 1]!;
    const band = clip(clip(s.polygon, p => localU(s, p) - low), p => high - localU(s, p));
    if (band.length < 3) continue;
    const o = openings.find(o => (low + high) / 2 > o.offset - E && (low + high) / 2 < o.offset + o.width + E);
    for (const piece of splitRoof(band, roof)) {
      m.surface([piece], p => topAt(project, w, p), true);
      if (!o || o.sill > E) m.surface([piece], () => w.base, false);
    }
  }
  // Boundary faces; split every edge at all opening planes and the roof ridge.
  for (let i = 0; i < s.polygon.length; i++) {
    const a = s.polygon[i]!, b = s.polygon[(i + 1) % s.polygon.length]!, ua = localU(s, a), ub = localU(s, b);
    const ts = [0, 1];
    if (Math.abs(ub - ua) > E) for (const cut of cuts) { const t = (cut - ua) / (ub - ua); if (t > E && t < 1 - E) ts.push(t); }
    if (roof?.kind === 'gable' && Math.abs(b.x - a.x) > E) { const t = (roofRidgeX(roof) - a.x) / (b.x - a.x); if (t > E && t < 1 - E) ts.push(t); }
    const sorted = unique(ts);
    for (let j = 0; j < sorted.length - 1; j++) {
      const aa = pointAt(a, b, sorted[j]!), bb = pointAt(a, b, sorted[j + 1]!);
      if (onJunctionEdge(aa, bb, seams)) continue;
      const midU = localU(s, pointAt(aa, bb, 0.5));
      const cutsA = jambCuts(localU(s, aa)), cutsB = jambCuts(localU(s, bb));
      const o = openings.find(o => midU > o.offset + E && midU < o.offset + o.width - E);
      if (o) {
        if (o.sill > E) m.vertical(aa, bb, w.base, w.base + o.sill, w.base + o.sill, cutsA, cutsB);
        m.vertical(aa, bb, w.base + o.sill + o.height, topAt(project, w, aa), topAt(project, w, bb), cutsA, cutsB);
      } else m.vertical(aa, bb, w.base, topAt(project, w, aa), topAt(project, w, bb), cutsA, cutsB);
    }
  }
  for (const o of openings) {
    const al = localPoint(s, o.offset, -w.thickness / 2), ar = localPoint(s, o.offset, w.thickness / 2), bl = localPoint(s, o.offset + o.width, -w.thickness / 2), br = localPoint(s, o.offset + o.width, w.thickness / 2);
    const bottom = w.base + o.sill, top = bottom + o.height;
    for (const [a, b] of [[al, ar], [br, bl]] as [Point2, Point2][]) {
      const ts = [0, 1];
      if (roof?.kind === 'gable' && Math.abs(b.x - a.x) > E) { const t = (roofRidgeX(roof) - a.x) / (b.x - a.x); if (t > E && t < 1 - E) ts.push(t); }
      const sorted = unique(ts);
      for (let i = 0; i < sorted.length - 1; i++) {
        const aa = pointAt(a, b, sorted[i]!), bb = pointAt(a, b, sorted[i + 1]!);
        m.vertical(aa, bb, bottom, top, top, jambCuts(localU(s, aa)), jambCuts(localU(s, bb)));
      }
    }
    for (const piece of splitRoof(ccw([al, bl, br, ar]), roof)) {
      m.surface([piece], () => top, false);
      if (o.sill > E) m.surface([piece], () => bottom, true);
    }
  }
  return m.data(w.id, 'wall', w.color);
}

/** Keeps the timber just clear of a coplanar ceiling so the two faces do not flicker. */
const BEAM_GAP = 0.004;
function beamMesh(project: Project, beam: Beam): MeshData {
  const m = new MeshBuilder();
  const footprint = ccw(beamFootprint(beam));
  const roof = beam.roofId ? project.roofs.find(item => item.id === beam.roofId) : undefined;
  const yTop = (point: Point2) => beamCeiling(project, beam, point) - BEAM_GAP;
  for (const piece of splitRoof(footprint, roof)) {
    m.surface([piece], yTop, true);
    m.surface([piece], point => yTop(point) - beam.depth, false);
  }
  for (let i = 0; i < footprint.length; i++) {
    const a = footprint[i]!, b = footprint[(i + 1) % footprint.length]!;
    const ts = [0, 1];
    if (roof?.kind === 'gable' && Math.abs(b.x - a.x) > E) {
      const t = (roofRidgeX(roof) - a.x) / (b.x - a.x);
      if (t > E && t < 1 - E) ts.push(t);
    }
    const cuts = unique(ts);
    for (let j = 0; j < cuts.length - 1; j++) {
      const aa = pointAt(a, b, cuts[j]!), bb = pointAt(a, b, cuts[j + 1]!);
      m.quad(
        [aa.x, yTop(aa) - beam.depth, aa.z],
        [bb.x, yTop(bb) - beam.depth, bb.z],
        [bb.x, yTop(bb), bb.z],
        [aa.x, yTop(aa), aa.z],
        [bb.z - aa.z, 0, aa.x - bb.x],
      );
    }
  }
  return m.data(beam.id, 'beam', beam.color);
}

export function buildGeometry(project: Project): GeometryResult {
  const diagnostics = validateGeometry(project);
  if (diagnostics.length) return { revision: project.revision, meshes: [], diagnostics };
  const meshes: MeshData[] = project.walls.map(w => wallMesh(project, wallShape(project, w)));
  for (const slab of project.slabs) {
    const m = new MeshBuilder(), outer = ccw(slab.polygon), holes = slab.holes.map(h => ccw(h).reverse()), rings = [outer, ...holes];
    m.surface(rings, () => slab.elevation, true); m.surface(rings, () => slab.elevation - slab.thickness, false);
    for (const ring of rings) for (let i = 0; i < ring.length; i++) m.vertical(ring[i]!, ring[(i + 1) % ring.length]!, slab.elevation - slab.thickness, slab.elevation, slab.elevation);
    meshes.push(m.data(slab.id, 'slab', slab.color));
  }
  for (const roof of project.roofs) {
    const m = new MeshBuilder();
    const polygon = [{ x: roof.x, z: roof.z }, { x: roof.x + roof.width, z: roof.z }, { x: roof.x + roof.width, z: roof.z + roof.depth }, { x: roof.x, z: roof.z + roof.depth }];
    for (const p of splitRoof(polygon, roof)) { m.surface([p], v => roofHeightAt(roof, v.x, v.z), true); m.surface([p], v => roofHeightAt(roof, v.x, v.z) - roof.thickness, false); }
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i]!, b = polygon[(i + 1) % polygon.length]!;
      const ts = [0, 1];
      if (roof.kind === 'gable' && Math.abs(b.x - a.x) > E) { const t = (roofRidgeX(roof) - a.x) / (b.x - a.x); if (t > E && t < 1 - E) ts.push(t); }
      const cuts = unique(ts);
      for (let j = 0; j < cuts.length - 1; j++) {
        const aa = pointAt(a, b, cuts[j]!), bb = pointAt(a, b, cuts[j + 1]!), ya = roofHeightAt(roof, aa.x, aa.z), yb = roofHeightAt(roof, bb.x, bb.z);
        m.quad([aa.x, ya, aa.z], [bb.x, yb, bb.z], [bb.x, yb - roof.thickness, bb.z], [aa.x, ya - roof.thickness, aa.z], [bb.z - aa.z, 0, aa.x - bb.x]);
      }
    }
    meshes.push(m.data(roof.id, 'roof', roof.color));
  }
  for (const beam of project.beams) meshes.push(beamMesh(project, beam));
  return { revision: project.revision, meshes, diagnostics: [] };
}

/** Drop a geometry job whose project revision is no longer current. */
export function adoptGeometry(currentRevision: number, result: GeometryResult): GeometryResult | null {
  return result.revision === currentRevision ? result : null;
}
