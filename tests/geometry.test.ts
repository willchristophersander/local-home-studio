import { describe, expect, it } from 'vitest';
import { createSample } from '../src/core/sample';
import { adoptGeometry, beamCeiling, buildGeometry, MIN_JUNCTION_ANGLE_DEGREES } from '../src/geometry';
import type { Beam, MeshData, Point2, Project, Roof, Wall } from '../src/shared/model';

type V = [number, number, number];

function blank(parts: Partial<Project>): Project {
  return {
    schemaVersion: 1, revision: 3, name: 'Fixture', nodes: [], storeys: [], walls: [], openings: [],
    slabs: [], roofs: [], beams: [], assets: [], instances: [], measurements: [], ...parts,
  };
}
function wall(id: string, start: string, end: string, extra: Partial<Wall> = {}): Wall {
  return { id, name: id, start, end, thickness: 0.2, base: 0, height: 2.7, color: '#d9d3c5', ...extra };
}
function triangles(mesh: MeshData): V[][] {
  const out: V[][] = [];
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const at = (index: number): V => {
      const offset = mesh.indices[index]! * 3;
      return [mesh.positions[offset]!, mesh.positions[offset + 1]!, mesh.positions[offset + 2]!];
    };
    out.push([at(i), at(i + 1), at(i + 2)]);
  }
  return out;
}
function volumeOf(meshes: MeshData[]): number {
  let sum = 0;
  for (const mesh of meshes) for (const [a, b, c] of triangles(mesh)) {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cross = [ab[1]! * ac[2]! - ab[2]! * ac[1]!, ab[2]! * ac[0]! - ab[0]! * ac[2]!, ab[0]! * ac[1]! - ab[1]! * ac[0]!];
    sum += a[0] * cross[0]! + a[1] * cross[1]! + a[2] * cross[2]!;
  }
  return sum / 6;
}
function boundaryProblems(meshes: MeshData[]): string[] {
  const counts = new Map<string, number>();
  const key = (vertex: V) => `${Math.round(vertex[0] * 1e8)},${Math.round(vertex[1] * 1e8)},${Math.round(vertex[2] * 1e8)}`;
  for (const mesh of meshes) for (const [a, b, c] of triangles(mesh)) {
    for (const [p, q] of [[a, b], [b, c], [c, a]] as Array<[V, V]>) {
      const left = key(p), right = key(q);
      const edge = left < right ? `${left}|${right}` : `${right}|${left}`;
      counts.set(edge, (counts.get(edge) ?? 0) + 1);
    }
  }
  return [...counts].filter(([, count]) => count !== 2).slice(0, 6).map(([edge, count]) => `${count}× ${edge}`);
}
function expectClosed(meshes: MeshData[], volume?: number): void {
  expect(meshes.length).toBeGreaterThan(0);
  for (const mesh of meshes) for (const value of mesh.positions) expect(Number.isFinite(value)).toBe(true);
  const problems = boundaryProblems(meshes);
  expect(problems, problems.join('\n')).toEqual([]);
  const actual = volumeOf(meshes);
  expect(actual).toBeGreaterThan(0);
  if (volume !== undefined) expect(actual).toBeCloseTo(volume, 6);
}
function meshesOf(project: Project): MeshData[] {
  const result = buildGeometry(project);
  expect(result.diagnostics.map(item => `${item.code}: ${item.message}`)).toEqual([]);
  return result.meshes;
}
function hasPlanVertex(meshes: MeshData[], x: number, z: number): boolean {
  return meshes.some(mesh => {
    for (let i = 0; i < mesh.positions.length; i += 3) {
      if (Math.hypot(mesh.positions[i]! - x, mesh.positions[i + 2]! - z) <= 1e-6) return true;
    }
    return false;
  });
}
/** Equal-thickness mitre corners from each sector bisector. Independent of the wall builder. */
function equalMitrePoints(angles: number[], half: number): Point2[] {
  const sorted = [...angles].sort((a, b) => a - b);
  return sorted.map((start, index) => {
    const next = sorted[(index + 1) % sorted.length]!;
    const sweep = (next - start + Math.PI * 2) % (Math.PI * 2);
    const bisector = start + sweep / 2;
    const distance = half / Math.sin(sweep / 2);
    return { x: distance * Math.cos(bisector), z: distance * Math.sin(bisector) };
  });
}
function rayHits(origin: V, direction: V, meshes: MeshData[]): number {
  let hits = 0;
  for (const mesh of meshes) for (const [v0, v1, v2] of triangles(mesh)) {
    const e1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
    const e2 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
    const pvec = [direction[1] * e2[2]! - direction[2] * e2[1]!, direction[2] * e2[0]! - direction[0] * e2[2]!, direction[0] * e2[1]! - direction[1] * e2[0]!];
    const det = e1[0]! * pvec[0]! + e1[1]! * pvec[1]! + e1[2]! * pvec[2]!;
    if (Math.abs(det) < 1e-9) continue;
    const inv = 1 / det;
    const tvec = [origin[0] - v0[0], origin[1] - v0[1], origin[2] - v0[2]];
    const u = (tvec[0]! * pvec[0]! + tvec[1]! * pvec[1]! + tvec[2]! * pvec[2]!) * inv;
    if (u < -1e-8 || u > 1 + 1e-8) continue;
    const qvec = [tvec[1]! * e1[2]! - tvec[2]! * e1[1]!, tvec[2]! * e1[0]! - tvec[0]! * e1[2]!, tvec[0]! * e1[1]! - tvec[1]! * e1[0]!];
    const v = (direction[0] * qvec[0]! + direction[1] * qvec[1]! + direction[2] * qvec[2]!) * inv;
    if (v < -1e-8 || u + v > 1 + 1e-8) continue;
    const t = (e2[0]! * qvec[0]! + e2[1]! * qvec[1]! + e2[2]! * qvec[2]!) * inv;
    if (t > 1e-6) hits += 1;
  }
  return hits;
}
function isInside(meshes: MeshData[], point: V): boolean {
  const directions: V[] = [[1, 0.17, 0.09], [0.13, 1, 0.07], [0.11, 0.19, 1]];
  const votes = directions.map(direction => rayHits(point, direction, meshes) % 2 === 1);
  const inside = votes.filter(Boolean).length;
  if (inside !== 0 && inside !== votes.length) throw new Error(`Ambiguous solid test at ${point.join(',')}`);
  return inside === votes.length;
}
function shoelace(points: Point2[]): number {
  return Math.abs(points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length]!;
    return sum + point.x * next.z - next.x * point.z;
  }, 0) / 2);
}

describe('wall junctions', () => {
  it('builds a 4 m by 6 m internal room with closed mixed corners', () => {
    const length = 4.2;
    const width = 6.2;
    const thickness = 0.2;
    const height = 2.7;
    const built = meshesOf(blank({
      nodes: [{ id: 'sw', x: 0, z: 0 }, { id: 'se', x: length, z: 0 }, { id: 'ne', x: length, z: width }, { id: 'nw', x: 0, z: width }],
      walls: [wall('s', 'sw', 'se'), wall('e', 'se', 'ne'), wall('n', 'ne', 'nw'), wall('w', 'nw', 'sw')],
    }));
    // Internal size is centreline minus thickness: 4.00 × 6.00, area 24.
    expect((length - thickness) * (width - thickness)).toBeCloseTo(24, 8);
    expectClosed(built, 2 * thickness * (length + width) * height);
    for (const [x, z] of [[-0.1, -0.1], [4.3, -0.1], [4.3, 6.3], [-0.1, 6.3], [0.1, 0.1], [4.1, 0.1], [4.1, 6.1], [0.1, 6.1]]) {
      expect(hasPlanVertex(built, x, z), `${x},${z}`).toBe(true);
    }
    expect(isInside(built, [2.1, 1, 0])).toBe(true);
    expect(isInside(built, [2.1, 1, 3.1])).toBe(false);
  });

  it.each([30, 135])('keeps equal-thickness %i° mitre corners', (degrees) => {
    const theta = degrees * Math.PI / 180;
    const half = 0.1;
    const built = meshesOf(blank({
      nodes: [{ id: 'a', x: 0, z: 0 }, { id: 'b', x: 5, z: 0 }, { id: 'c', x: 5 * Math.cos(theta), z: 5 * Math.sin(theta) }],
      walls: [wall('ab', 'a', 'b'), wall('ac', 'a', 'c')],
    }));
    expectClosed(built, 2 * 5 * 0.2 * 2.7);
    for (const point of equalMitrePoints([0, theta], half)) expect(hasPlanVertex(built, point.x, point.z)).toBe(true);
  });

  it('joins unequal thicknesses and rejects angles under 15°', () => {
    expect(MIN_JUNCTION_ANGLE_DEGREES).toBe(15);
    const corner = meshesOf(blank({
      nodes: [{ id: 'a', x: 0, z: 0 }, { id: 'b', x: 4, z: 0 }, { id: 'c', x: 0, z: 4 }],
      walls: [wall('ab', 'a', 'b', { thickness: 0.2 }), wall('ac', 'a', 'c', { thickness: 0.1 })],
    }));
    expectClosed(corner);
    // Left offset of the 0.2 m wall is z=0.1; right offset of the 0.1 m wall is x=0.05.
    expect(hasPlanVertex(corner, 0.05, 0.1)).toBe(true);
    expect(hasPlanVertex(corner, -0.05, -0.1)).toBe(true);
    const stem = meshesOf(blank({
      nodes: [{ id: 'l', x: -3, z: 0 }, { id: 'c', x: 0, z: 0 }, { id: 'r', x: 3, z: 0 }, { id: 's', x: 0, z: 3 }],
      walls: [wall('lc', 'l', 'c', { thickness: 0.2 }), wall('cr', 'c', 'r', { thickness: 0.2 }), wall('cs', 'c', 's', { thickness: 0.1 })],
    }));
    expectClosed(stem);
    expect(isInside(stem, [1, 1, 0])).toBe(true);
    expect(isInside(stem, [0, 1, 1.5])).toBe(true);
    expect(isInside(stem, [0.2, 1, 1.5])).toBe(false);

    const tight = 14 * Math.PI / 180;
    const rejected = buildGeometry(blank({
      nodes: [{ id: 'a', x: 0, z: 0 }, { id: 'b', x: 4, z: 0 }, { id: 'c', x: 4 * Math.cos(tight), z: 4 * Math.sin(tight) }],
      walls: [wall('ab', 'a', 'b'), wall('ac', 'a', 'c')],
    }));
    expect(rejected.meshes).toEqual([]);
    expect(rejected.diagnostics.some(item => item.code === 'JUNCTION_ANGLE')).toBe(true);

    const allowed = 15 * Math.PI / 180;
    const acute = meshesOf(blank({
      nodes: [{ id: 'a', x: 0, z: 0 }, { id: 'b', x: 5, z: 0 }, { id: 'c', x: 5 * Math.cos(allowed), z: 5 * Math.sin(allowed) }],
      walls: [wall('ab', 'a', 'b'), wall('ac', 'a', 'c')],
    }));
    expectClosed(acute, 2 * 5 * 0.2 * 2.7);
    for (const point of equalMitrePoints([0, allowed], 0.1)) expect(hasPlanVertex(acute, point.x, point.z)).toBe(true);
  });

  it('builds an X junction and allows crossings only at separate heights', () => {
    const built = meshesOf(blank({
      nodes: [{ id: 'w', x: -3, z: 0 }, { id: 'e', x: 3, z: 0 }, { id: 's', x: 0, z: -3 }, { id: 'n', x: 0, z: 3 }, { id: 'c', x: 0, z: 0 }],
      walls: [wall('cw', 'c', 'w'), wall('ce', 'c', 'e'), wall('cs', 'c', 's'), wall('cn', 'c', 'n')],
    }));
    // Two 6 m bars of 0.2 m thickness, sharing one 0.2 m square.
    expectClosed(built, (2 * 6 * 0.2 - 0.04) * 2.7);

    const separated = meshesOf(blank({
      nodes: [{ id: 'a', x: 0, z: 0 }, { id: 'b', x: 4, z: 0 }, { id: 'c', x: 2, z: -2 }, { id: 'd', x: 2, z: 2 }],
      walls: [wall('ab', 'a', 'b', { height: 2.4 }), wall('cd', 'c', 'd', { base: 3, height: 2.4 })],
    }));
    expectClosed(separated, 2 * 4 * 0.2 * 2.4);
    const crossing = buildGeometry(blank({
      nodes: [{ id: 'a', x: 0, z: 0 }, { id: 'b', x: 4, z: 0 }, { id: 'c', x: 2, z: -2 }, { id: 'd', x: 2, z: 2 }],
      walls: [wall('ab', 'a', 'b', { height: 2.4 }), wall('cd', 'c', 'd', { base: 2, height: 2.4 })],
    }));
    expect(crossing.diagnostics.some(item => item.code === 'UNCONNECTED_CROSSING')).toBe(true);
  });
});

describe('hosted openings', () => {
  const host = blank({
    nodes: [{ id: 'a', x: 0, z: 0 }, { id: 'b', x: 4, z: 0 }],
    walls: [wall('host', 'a', 'b')],
    openings: [{ id: 'win', wallId: 'host', kind: 'window', offset: 1.4, width: 1.2, sill: 1, height: 1 }],
  });

  it('cuts the specified window and carries it with the host', () => {
    const built = meshesOf(host);
    expectClosed(built, 4 * 0.2 * 2.7 - 1.2 * 1 * 0.2);
    expect(isInside(built, [2, 0.4, 0])).toBe(true);
    expect(isInside(built, [2, 1.5, 0])).toBe(false);

    const moved = structuredClone(host);
    for (const node of moved.nodes) { node.x += 1; node.z += 2; }
    const translated = meshesOf(moved);
    expect(moved.openings[0]!.offset).toBe(1.4);
    expect(isInside(translated, [3, 0.4, 2])).toBe(true);
    expect(isInside(translated, [3, 1.5, 2])).toBe(false);

    const rotated = structuredClone(host);
    rotated.nodes[1] = { id: 'b', x: 0, z: 4 };
    const turned = meshesOf(rotated);
    expect(rotated.openings[0]!.offset).toBe(1.4);
    expect(isInside(turned, [0, 0.4, 2])).toBe(true);
    expect(isInside(turned, [0, 1.5, 2])).toBe(false);
  });

  it('rejects a shortened host without changing the previous solid', () => {
    const before = meshesOf(host);
    const shortened = structuredClone(host);
    shortened.nodes[1] = { id: 'b', x: 1, z: 0 };
    const result = buildGeometry(shortened);
    expect(result.meshes).toEqual([]);
    expect(result.diagnostics.some(item => item.code === 'OPENING_OUTSIDE_WALL' || item.code === 'OPENING_BOUNDS')).toBe(true);
    expect(isInside(before, [2, 0.4, 0])).toBe(true);
  });
});

describe('slabs', () => {
  it('preserves concave area, holes, and thickness', () => {
    const concave = [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 1 }, { x: 1, z: 1 }, { x: 1, z: 3 }, { x: 0, z: 3 }];
    const hole = [{ x: 1, z: 1 }, { x: 3, z: 1 }, { x: 3, z: 2 }, { x: 1, z: 2 }];
    const outer = [{ x: 0, z: 0 }, { x: 6, z: 0 }, { x: 6, z: 4 }, { x: 0, z: 4 }];
    const built = meshesOf(blank({
      slabs: [
        { id: 'l', name: 'L', polygon: concave, holes: [], elevation: 0.6, thickness: 0.2, color: '#c8b496' },
        { id: 'holed', name: 'Holed', polygon: outer, holes: [hole], elevation: 0, thickness: 0.25, color: '#bda580' },
      ],
    }));
    expectClosed([built.find(mesh => mesh.id === 'l')!], shoelace(concave) * 0.2);
    expectClosed([built.find(mesh => mesh.id === 'holed')!], (shoelace(outer) - shoelace(hole)) * 0.25);
    expect(buildGeometry(blank({ slabs: [{ id: 'bad', name: 'Bad', polygon: [{ x: 0, z: 0 }, { x: 2, z: 2 }, { x: 0, z: 2 }, { x: 2, z: 0 }], holes: [], elevation: 0, thickness: 0.2, color: '#bda580' }] })).diagnostics.some(item => item.code === 'INVALID_SLAB')).toBe(true);
    expect(buildGeometry(blank({ slabs: [{ id: 'bad', name: 'Bad', polygon: outer, holes: [[{ x: -1, z: -1 }, { x: 1, z: -1 }, { x: 1, z: 1 }]], elevation: 0, thickness: 0.2, color: '#bda580' }] })).diagnostics.some(item => item.code === 'INVALID_SLAB_HOLE')).toBe(true);
  });

  it('rejects two slabs in the same volume and allows one sitting in a hole', () => {
    const outer = [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 4 }, { x: 0, z: 4 }];
    const hole = [{ x: 1, z: 1 }, { x: 3, z: 1 }, { x: 3, z: 3 }, { x: 1, z: 3 }];
    const slab = (id: string, polygon: typeof outer, holes: typeof outer[], elevation: number) => ({ id, name: id, polygon, holes, elevation, thickness: 0.2, color: '#bda580' });
    expect(buildGeometry(blank({ slabs: [slab('lower', outer, [], 0), slab('upper', outer, [], 0.1)] })).diagnostics.some(item => item.code === 'SLAB_OVERLAP')).toBe(true);
    expect(buildGeometry(blank({ slabs: [slab('lower', outer, [], 0), slab('upper', outer, [], 0.2)] })).diagnostics).toEqual([]);
    expect(buildGeometry(blank({ slabs: [slab('lower', outer, [hole], 0), slab('upper', hole, [], 0)] })).diagnostics).toEqual([]);
  });
});

describe('roofs', () => {
  function gable(extra: Partial<Roof> = {}): Roof {
    return { id: 'roof', name: 'Roof', kind: 'gable', x: 0, z: 0, width: 8, depth: 6, eaveHeight: 3, pitchLeft: 20, pitchRight: 40, thickness: 0.15, color: '#667066', ...extra };
  }
  function ridge(roof: Roof): { x: number; height: number } {
    const left = Math.tan(roof.pitchLeft * Math.PI / 180);
    const right = Math.tan(roof.pitchRight * Math.PI / 180);
    const x = roof.x + roof.width * right / (left + right);
    return { x, height: roof.eaveHeight + (x - roof.x) * left };
  }
  function heightsNear(mesh: MeshData, x: number): number[] {
    const found = new Set<number>();
    for (let i = 0; i < mesh.positions.length; i += 3) {
      if (Math.abs(mesh.positions[i]! - x) <= 1e-6) found.add(Math.round(mesh.positions[i + 1]! * 1e6) / 1e6);
    }
    return [...found].sort((a, b) => a - b);
  }

  it('holds one asymmetric ridge while both eaves stay fixed', () => {
    const roof = gable();
    const expected = ridge(roof);
    const rightRise = (roof.x + roof.width - expected.x) * Math.tan(roof.pitchRight * Math.PI / 180);
    expect(expected.height).toBeCloseTo(roof.eaveHeight + rightRise, 8);
    const mesh = meshesOf(blank({ roofs: [roof] })).find(item => item.id === 'roof')!;
    expectClosed([mesh], roof.width * roof.depth * roof.thickness);
    expect(heightsNear(mesh, expected.x)).toEqual([
      Math.round((expected.height - roof.thickness) * 1e6) / 1e6,
      Math.round(expected.height * 1e6) / 1e6,
    ]);
    expect(heightsNear(mesh, roof.x)).toEqual([
      Math.round((roof.eaveHeight - roof.thickness) * 1e6) / 1e6,
      Math.round(roof.eaveHeight * 1e6) / 1e6,
    ]);

    const steeper = gable({ pitchRight: 55 });
    const next = ridge(steeper);
    expect(next.x).toBeGreaterThan(expected.x);
    expect(next.height).toBeGreaterThan(roof.eaveHeight);
    const updated = meshesOf(blank({ roofs: [steeper] })).find(item => item.id === 'roof')!;
    expect(heightsNear(updated, roof.x)).toEqual(heightsNear(mesh, roof.x));
    expect(heightsNear(updated, next.x)).toContain(Math.round(next.height * 1e6) / 1e6);
  });

  it('updates a linked wall and blocks an opening that would rise through the roof', () => {
    const roof = gable({ kind: 'shed', pitchLeft: 18, pitchRight: 0, eaveHeight: 3.2, thickness: 0.1, depth: 4 });
    const linked = blank({
      nodes: [{ id: 'a', x: 1, z: 1 }, { id: 'b', x: 5, z: 1 }],
      walls: [wall('side', 'a', 'b', { roofId: 'roof', height: 2.4 })],
      roofs: [roof],
    });
    const built = meshesOf(linked);
    const wallMesh = built.find(item => item.id === 'side')!;
    const rise = Math.tan(18 * Math.PI / 180);
    const topAt = (x: number) => roof.eaveHeight + (x - roof.x) * rise - roof.thickness;
    const maxY = (x: number) => {
      let high = -Infinity;
      for (let i = 0; i < wallMesh.positions.length; i += 3) if (Math.abs(wallMesh.positions[i]! - x) <= 1e-6) high = Math.max(high, wallMesh.positions[i + 1]!);
      return high;
    };
    expect(maxY(1)).toBeCloseTo(topAt(1), 6);
    expect(maxY(5)).toBeCloseTo(topAt(5), 6);
    expectClosed(built.filter(item => item.kind === 'wall'));

    const blocked = structuredClone(linked);
    blocked.openings = [{ id: 'high', wallId: 'side', kind: 'window', offset: 0.4, width: 1, sill: 1.2, height: 2 }];
    blocked.roofs[0] = { ...roof, eaveHeight: 2.6 };
    expect(buildGeometry(blocked).diagnostics.some(item => item.code === 'OPENING_TOP')).toBe(true);
    expect(buildGeometry(blank({ roofs: [gable({ pitchLeft: 0 })] })).diagnostics.some(item => item.code === 'INVALID_ROOF')).toBe(true);
  });
});

describe('sample and stale geometry', () => {
  it('meshes the split-level sample as closed solids', () => {
    const sample = createSample();
    const built = meshesOf(sample);
    const shells = new Map<string, typeof built>();
    for (const mesh of built.filter(item => item.kind === 'wall')) {
      const base = sample.walls.find(wall => wall.id === mesh.id)!.base.toFixed(4);
      shells.set(base, [...(shells.get(base) ?? []), mesh]);
    }
    for (const shell of shells.values()) expectClosed(shell);
    for (const mesh of built.filter(mesh => mesh.kind !== 'wall')) expectClosed([mesh]);
    expect(sample.slabs.find(slab => slab.id === 'floor')!.holes[0]).toEqual(sample.slabs.find(slab => slab.id === 'platform')!.polygon);
    const main = sample.slabs.find(slab => slab.id === 'floor')!;
    const mudroom = sample.slabs.find(slab => slab.id === 'mud-floor')!;
    expect(main.elevation - mudroom.elevation).toBeCloseTo(sample.walls.find(wall => wall.id === 'south')!.height / 2);
    const stairs = sample.slabs.filter(slab => slab.id.startsWith('stair-')).sort((a, b) => a.elevation - b.elevation);
    expect(stairs).toHaveLength(8);
    expect(stairs[0]!.elevation).toBeCloseTo(mudroom.elevation + 1.45 / 8);
    expect(stairs[7]!.elevation).toBe(0);
    expect(stairs[7]!.polygon).toEqual(expect.arrayContaining([{ x: 0.62, z: -0.1 }]));
    const foundations = sample.walls.filter(wall => wall.finish === 'concrete');
    expect(foundations).toHaveLength(16);
    const garage = sample.slabs.find(slab => slab.id === 'ga-floor')!;
    expect(garage.elevation).toBe(main.elevation);
    const garageZ = garage.polygon.map(point => point.z);
    const overlaps = (left: number[], right: number[]) => Math.min(...left) < Math.max(...right) && Math.max(...left) > Math.min(...right);
    expect(Math.max(...garage.polygon.map(point => point.x))).toBeLessThan(0);
    expect(overlaps(garageZ, mudroom.polygon.map(point => point.z))).toBe(true);
    expect(overlaps(garageZ, main.polygon.map(point => point.z))).toBe(true);
    for (const wall of foundations) {
      expect(sample.walls.some(above => above.finish !== 'concrete' && above.start === wall.start && above.end === wall.end && above.base === wall.base + wall.height)).toBe(true);
    }
    const upper = sample.slabs.find(slab => slab.id === 'upper-floor')!;
    const mudUpper = sample.slabs.find(slab => slab.id === 'mud-upper')!;
    expect(upper.elevation - main.elevation).toBeCloseTo(2.9);
    expect(mudUpper.elevation - mudroom.elevation).toBeCloseTo(2.9);
    expect(upper.elevation - mudUpper.elevation).toBeCloseTo(1.45);
    const garden = sample.roofs.find(roof => roof.id === 'g-roof')!;
    expect(garden).toMatchObject({ kind: 'gable', pitchLeft: 30, pitchRight: 30 });
    expect(sample.walls.filter(wall => wall.roofId === 'g-roof')).toHaveLength(4);
    const ridgeX = garden.x + garden.width / 2;
    const rise = (garden.width / 2) * Math.tan(30 * Math.PI / 180);
    const roofMesh = built.find(mesh => mesh.id === 'g-roof')!;
    const ridgeHeights = new Set<number>();
    for (let index = 0; index < roofMesh.positions.length; index += 3) {
      if (Math.abs(roofMesh.positions[index]! - ridgeX) <= 1e-6) ridgeHeights.add(Math.round(roofMesh.positions[index + 1]! * 1e6) / 1e6);
    }
    expect([...ridgeHeights].sort((a, b) => a - b)).toEqual([
      Math.round((garden.eaveHeight + rise - garden.thickness) * 1e6) / 1e6,
      Math.round((garden.eaveHeight + rise) * 1e6) / 1e6,
    ]);
    const beams = sample.beams.filter(beam => beam.storeyId === 'ground');
    expect(beams).toHaveLength(3);
    for (const beam of beams) {
      expect(beam.elevation).toBeCloseTo(2.7);
      expect(beam.depth).toBeCloseTo(0.32);
      expect(beam.width).toBeCloseTo(0.24);
    }
    expect(sample.slabs.find(slab => slab.id === 'upper-floor')!.ceiling).toBe('planks');
    expect(sample.beams.some(beam => beam.roofId === 'roof')).toBe(true);
  });

  it('hangs a beam under a ceiling and from a roof', () => {
    const ceiling = { id: 'ceil', name: 'Ceiling', polygon: [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 3 }, { x: 0, z: 3 }], holes: [], elevation: 2.7, thickness: 0.2, color: '#d4c4a8' };
    const beam = (extra: Partial<Beam> = {}): Beam => ({ id: 'beam', name: 'Beam', x: 0.2, z: 1.5, length: 3.4, width: 0.16, depth: 0.2, elevation: 2.5, axis: 'x', color: '#8d5e3a', ...extra });
    const hung = meshesOf(blank({ slabs: [ceiling], beams: [beam()] }));
    expectClosed([hung.find(mesh => mesh.id === 'beam')!], 3.4 * 0.16 * 0.2);
    const buried = buildGeometry(blank({ slabs: [ceiling], beams: [beam({ elevation: 2.65 })] }));
    expect(buried.diagnostics.some(item => item.code === 'BEAM_OVERLAP')).toBe(true);
    const roof = { id: 'roof', name: 'Roof', kind: 'gable' as const, x: 0, z: 0, width: 6, depth: 4, eaveHeight: 2.8, pitchLeft: 30, pitchRight: 30, thickness: 0.12, color: '#667066' };
    const rafter = beam({ x: 1.2, z: 0.3, length: 3.2, axis: 'z', elevation: 0, roofId: 'roof' });
    const project = blank({ roofs: [roof], beams: [rafter] });
    const mesh = meshesOf(project).find(item => item.id === 'beam')!;
    expectClosed([mesh], rafter.length * rafter.width * rafter.depth);
    const tops = mesh.positions.filter((_, index) => index % 3 === 1);
    const high = { x: rafter.x + rafter.width / 2, z: rafter.z };
    expect(Math.max(...tops)).toBeCloseTo(beamCeiling(project, rafter, high) - 0.004, 5);
  });

  it('discards geometry from an older revision', () => {
    const current = buildGeometry(createSample());
    expect(adoptGeometry(current.revision, current)?.meshes.length).toBeGreaterThan(0);
    expect(adoptGeometry(current.revision + 1, current)).toBeNull();
  });
});
