import { roofHeightAt, roofRidgeX } from '../geometry';
import type { Project, Wall } from '../shared/model';

/** Local X runs along the piece, local Y across its face, local Z outward. */
export interface TrimBox {
  wallId: string;
  kind: 'corner' | 'casing' | 'header' | 'sill' | 'water-table' | 'fascia' | 'rake';
  center: [number, number, number];
  size: [number, number, number];
  axisX: [number, number, number];
  axisY: [number, number, number];
  axisZ: [number, number, number];
}

const CORNER = 0.09;
const CASING = 0.07;
const GAP = 0.008;

function normalize(x: number, y: number, z: number): [number, number, number] {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function basis(along: [number, number, number], outward: [number, number, number]): Pick<TrimBox, 'axisX' | 'axisY' | 'axisZ'> {
  const axisX = normalize(...along);
  const axisZ = normalize(...outward);
  const axisY = normalize(...cross(axisZ, axisX));
  return { axisX, axisY, axisZ };
}

function wallTop(project: Project, wall: Wall, x: number): number {
  const roof = wall.roofId ? project.roofs.find(item => item.id === wall.roofId) : undefined;
  return roof ? roofHeightAt(roof, x, 0) - roof.thickness : wall.base + wall.height;
}

/** Trim for every sided wall: corner boards, opening frames, and the boards at the foundation and eaves. */
export function wallAccessories(project: Project): TrimBox[] {
  const boxes: TrimBox[] = [];
  for (const wall of project.walls) {
    if (wall.finish === 'concrete') continue;
    const start = project.nodes.find(node => node.id === wall.start);
    const end = project.nodes.find(node => node.id === wall.end);
    if (!start || !end) continue;
    const length = Math.hypot(end.x - start.x, end.z - start.z);
    if (length < 0.05) continue;
    const dx = (end.x - start.x) / length;
    const dz = (end.z - start.z) / length;
    let nx = dz;
    let nz = -dx;
    const slabs = project.slabs.filter(slab => slab.storeyId === wall.storeyId && slab.polygon.length > 0);
    if (slabs.length) {
      let cx = 0;
      let cz = 0;
      let count = 0;
      for (const slab of slabs) for (const point of slab.polygon) { cx += point.x; cz += point.z; count += 1; }
      const midX = (start.x + end.x) / 2;
      const midZ = (start.z + end.z) / 2;
      if ((cx / count - midX) * nx + (cz / count - midZ) * nz > 0) { nx = -nx; nz = -nz; }
    }
    const half = wall.thickness / 2;
    const xAt = (u: number, out: number) => start.x + dx * u + nx * out;
    const zAt = (u: number, out: number) => start.z + dz * u + nz * out;
    const place = (kind: TrimBox['kind'], u: number, y: number, along: number, up: number, out: number, dir: [number, number, number] = [dx, 0, dz]) => {
      if (along < 0.02 || up < 0.02 || out <= 0) return;
      const proud = half + GAP + out / 2;
      const frame = basis(dir, [nx, 0, nz]);
      boxes.push({ wallId: wall.id, kind, center: [xAt(u, proud), y, zAt(u, proud)], size: [along, up, out], ...frame });
    };

    for (const u of [CORNER / 2, length - CORNER / 2]) {
      const top = wallTop(project, wall, xAt(u, 0));
      place('corner', u, (wall.base + top) / 2, CORNER, top - wall.base, 0.03);
    }

    const concrete = project.walls.find(other => other.finish === 'concrete' && other.start === wall.start && other.end === wall.end && Math.abs(other.base + other.height - wall.base) < 1e-3);
    if (concrete && length > CORNER * 2 + 0.05) {
      place('water-table', length / 2, wall.base, length - CORNER * 2, 0.11, 0.02);
    }

    const ends = [wallTop(project, wall, start.x), wallTop(project, wall, end.x)];
    const midTop = wallTop(project, wall, start.x + dx * length / 2);
    const flat = Math.abs(ends[0]! - ends[1]!) < 0.04 && Math.abs(midTop - Math.min(ends[0]!, ends[1]!)) < 0.04;
    const continues = project.walls.some(other => other.id !== wall.id && other.finish !== 'concrete' && other.start === wall.start && other.end === wall.end && Math.abs(other.base - ends[0]!) < 1e-3);
    if (flat && !continues && length > CORNER * 2 + 0.05) {
      const top = Math.min(...ends);
      place('fascia', length / 2, top - 0.055, length - CORNER * 2, 0.11, 0.025);
    }
    if (!flat && wall.roofId) {
      const roof = project.roofs.find(item => item.id === wall.roofId);
      const ridgeU = roof ? Math.max(0, Math.min(length, (roofRidgeX(roof) - start.x) / (dx || 1e-6))) : length / 2;
      for (const [u0, u1] of [[CORNER, ridgeU], [ridgeU, length - CORNER]] as Array<[number, number]>) {
        if (u1 - u0 < 0.2) continue;
        const y0 = wallTop(project, wall, xAt(u0, 0));
        const y1 = wallTop(project, wall, xAt(u1, 0));
        const run: [number, number, number] = [dx * (u1 - u0), y1 - y0, dz * (u1 - u0)];
        const faceUp = normalize(...cross(normalize(...run), [nx, 0, nz]));
        const drop = faceUp[1] >= 0 ? faceUp : [-faceUp[0], -faceUp[1], -faceUp[2]] as [number, number, number];
        const midU = (u0 + u1) / 2;
        const midY = (y0 + y1) / 2 - drop[1] * 0.05;
        const proud = half + GAP + 0.012;
        const frame = basis(run, [nx, 0, nz]);
        boxes.push({
          wallId: wall.id,
          kind: 'rake',
          center: [xAt(midU, proud) - drop[0] * 0.05, midY, zAt(midU, proud) - drop[2] * 0.05],
          size: [Math.hypot(...run), 0.1, 0.025],
          ...frame,
        });
      }
    }

    for (const opening of project.openings.filter(item => item.wallId === wall.id)) {
      const head = wall.base + opening.sill + opening.height;
      const sill = wall.base + opening.sill;
      const u0 = opening.offset;
      const u1 = opening.offset + opening.width;
      const sideTop = head + CASING / 2;
      const sideBottom = opening.kind === 'window' ? sill : wall.base;
      place('casing', u0 - CASING / 2, (sideBottom + sideTop) / 2, CASING, sideTop - sideBottom, 0.025);
      place('casing', u1 + CASING / 2, (sideBottom + sideTop) / 2, CASING, sideTop - sideBottom, 0.025);
      place('header', (u0 + u1) / 2, head + CASING / 2, opening.width + CASING * 2, CASING, 0.032);
      if (opening.kind === 'window') place('sill', (u0 + u1) / 2, sill - 0.02, opening.width + CASING * 2, 0.04, 0.05);
    }
  }
  return boxes;
}
