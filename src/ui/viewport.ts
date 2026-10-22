import {
  ArcRotateCamera,
  Color3,
  Color4,
  DirectionalLight,
  DynamicTexture,
  Engine,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  Plane,
  Scene,
  SceneLoader,
  StandardMaterial,
  Texture,
  TransformNode,
  Vector3,
  VertexData,
  type Node,
} from '@babylonjs/core';
import '@babylonjs/loaders/glTF';
import { wallAccessories } from './accessories';
import { outwardNormal } from './edit';
import { nearestWallId } from './nearest-wall';
import { instanceWorldPose } from '../placement';
import type { Asset, GeometryResult, Instance, Project } from '../shared/model';
import type { WorldPose } from '../placement';

export interface MarkerSize { width: number; height: number; depth: number }
export interface ViewHandle {
  update(project: Project, geometry: GeometryResult, selectedId: string | null, clip: number | null): void;
  setLookInside(enabled: boolean): void;
  loadMarker(url: string): Promise<MarkerSize>;
  dispose(): void;
}

/** One clapboard course. World height maps 0.16 m onto this tile. */
function createSiding(scene: Scene): DynamicTexture {
  const texture = new DynamicTexture('siding', { width: 128, height: 64 }, scene, false);
  const context = texture.getContext();
  for (let y = 0; y < 64; y += 1) {
    for (let x = 0; x < 128; x += 1) {
      const mottling = ((x * 13 + y * 29) % 19) / 19;
      const shade = 226 + Math.floor(mottling * 24);
      context.fillStyle = `rgb(${shade}, ${shade - 4}, ${shade - 12})`;
      context.fillRect(x, y, 1, 1);
    }
  }
  context.fillStyle = 'rgba(72, 58, 44, 0.72)';
  context.fillRect(0, 54, 128, 10);
  context.fillStyle = 'rgba(255, 252, 246, 0.55)';
  context.fillRect(0, 52, 128, 2);
  texture.update(false);
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  return texture;
}

function createConcrete(scene: Scene): DynamicTexture {
  const texture = new DynamicTexture('concrete', { width: 128, height: 128 }, scene, false);
  const context = texture.getContext();
  for (let y = 0; y < 128; y += 1) {
    for (let x = 0; x < 128; x += 1) {
      const speck = ((x * 17 + y * 31) % 23) / 23;
      const shade = 214 + Math.floor(speck * 28);
      context.fillStyle = `rgb(${shade}, ${shade - 1}, ${shade - 4})`;
      context.fillRect(x, y, 1, 1);
    }
  }
  context.fillStyle = 'rgba(88, 84, 78, 0.38)';
  context.fillRect(0, 118, 128, 4);
  context.fillStyle = 'rgba(255, 252, 248, 0.3)';
  context.fillRect(0, 116, 128, 2);
  texture.update(false);
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  return texture;
}

function createWood(scene: Scene): DynamicTexture {
  const texture = new DynamicTexture('wood', { width: 256, height: 64 }, scene, false);
  const context = texture.getContext();
  for (let y = 0; y < 64; y += 1) {
    for (let x = 0; x < 256; x += 1) {
      const wave = Math.sin(x * 0.045) * 6 + Math.sin(x * 0.013 + 2) * 3;
      const ring = Math.sin((y + wave) * 0.72);
      const fleck = ((x * 13 + y * 29) % 17) / 17;
      const knot = Math.hypot(x - 150, (y - 28) * 3.2);
      const shade = 132 + ring * 18 + fleck * 10 - Math.max(0, 14 - knot);
      context.fillStyle = `rgb(${Math.round(shade + 36)}, ${Math.round(shade - 6)}, ${Math.round(shade - 48)})`;
      context.fillRect(x, y, 1, 1);
    }
  }
  texture.update(false);
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  return texture;
}

/** One board across the texture. Seams repeat every 0.14 m of plan X, so the boards run north–south, across the east–west beams. */
function createPlanks(scene: Scene): DynamicTexture {
  const texture = new DynamicTexture('planks', { width: 64, height: 256 }, scene, false);
  const context = texture.getContext();
  for (let y = 0; y < 256; y += 1) {
    for (let x = 0; x < 64; x += 1) {
      const seam = x < 4 || x > 59;
      const speck = ((x * 13 + y * 5) % 5) - 2;
      const shade = seam ? 22 : 104 + speck;
      context.fillStyle = `rgb(${Math.round(shade + 22)}, ${Math.round(shade - 14)}, ${Math.round(shade - 36)})`;
      context.fillRect(x, y, 1, 1);
    }
  }
  texture.update(false);
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  return texture;
}

function wallSurface(positions: number[], indices: number[], course = 0.16) {
  const nextPositions: number[] = [];
  const nextIndices: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  for (let index = 0; index < indices.length; index += 3) {
    const corners = [0, 1, 2].map(offset => {
      const vertex = indices[index + offset]! * 3;
      return [positions[vertex]!, positions[vertex + 1]!, positions[vertex + 2]!];
    });
    const edgeA = [corners[1]![0] - corners[0]![0], corners[1]![1] - corners[0]![1], corners[1]![2] - corners[0]![2]];
    const edgeB = [corners[2]![0] - corners[0]![0], corners[2]![1] - corners[0]![1], corners[2]![2] - corners[0]![2]];
    let nx = edgeA[1]! * edgeB[2]! - edgeA[2]! * edgeB[1]!;
    let ny = edgeA[2]! * edgeB[0]! - edgeA[0]! * edgeB[2]!;
    let nz = edgeA[0]! * edgeB[1]! - edgeA[1]! * edgeB[0]!;
    const length = Math.hypot(nx, ny, nz) || 1;
    nx /= length; ny /= length; nz /= length;
    const base = nextPositions.length / 3;
    for (const point of corners) {
      nextPositions.push(point[0]!, point[1]!, point[2]!);
      normals.push(nx, ny, nz);
      const along = Math.abs(nx) > Math.abs(nz) ? point[2]! : point[0]!;
      const horizontal = Math.abs(ny) > 0.65;
      uvs.push(horizontal ? point[0]! * 1.4 : along * 0.85, horizontal ? point[2]! * 1.4 : point[1]! / course);
    }
    nextIndices.push(base, base + 1, base + 2);
  }
  return { positions: nextPositions, indices: nextIndices, normals, uvs };
}

interface Surface { positions: number[]; indices: number[]; normals: number[]; uvs: number[] }
function blankSurface(): Surface {
  return { positions: [], indices: [], normals: [], uvs: [] };
}
function pushTriangle(surface: Surface, corners: number[][], normal: number[], uv: (point: number[]) => [number, number]): void {
  const base = surface.positions.length / 3;
  for (const point of corners) {
    surface.positions.push(point[0]!, point[1]!, point[2]!);
    surface.normals.push(normal[0]!, normal[1]!, normal[2]!);
    const mapped = uv(point);
    surface.uvs.push(mapped[0], mapped[1]);
  }
  surface.indices.push(base, base + 1, base + 2);
}
/** Exterior siding, the painted room face, and the top, ends, and jambs. */
function splitWall(positions: number[], indices: number[], outward: { x: number; z: number }, course: number): { outside: Surface; inside: Surface; edge: Surface } {
  const outside = blankSurface();
  const inside = blankSurface();
  const edge = blankSurface();
  for (let index = 0; index < indices.length; index += 3) {
    const corners = [0, 1, 2].map(offset => {
      const vertex = indices[index + offset]! * 3;
      return [positions[vertex]!, positions[vertex + 1]!, positions[vertex + 2]!];
    });
    const edgeA = [corners[1]![0] - corners[0]![0], corners[1]![1] - corners[0]![1], corners[1]![2] - corners[0]![2]];
    const edgeB = [corners[2]![0] - corners[0]![0], corners[2]![1] - corners[0]![1], corners[2]![2] - corners[0]![2]];
    let nx = edgeA[1]! * edgeB[2]! - edgeA[2]! * edgeB[1]!;
    let ny = edgeA[2]! * edgeB[0]! - edgeA[0]! * edgeB[2]!;
    let nz = edgeA[0]! * edgeB[1]! - edgeA[1]! * edgeB[0]!;
    const length = Math.hypot(nx, ny, nz) || 1;
    nx /= length; ny /= length; nz /= length;
    const facing = nx * outward.x + nz * outward.z;
    const target = facing > 0.35 ? outside : facing < -0.35 ? inside : edge;
    const horizontal = Math.abs(ny) > 0.65;
    pushTriangle(target, corners, [nx, ny, nz], point => {
      const along = Math.abs(nx) > Math.abs(nz) ? point[2]! : point[0]!;
      return [horizontal ? point[0]! * 1.4 : along * 0.85, horizontal ? point[2]! * 1.4 : point[1]! / course];
    });
  }
  return { outside, inside, edge };
}
/** Splits a slab into the floor top, the plank underside, and the vertical edge. */
function slabFaces(positions: number[], indices: number[]): { up: Surface; down: Surface; side: Surface } {
  const up = blankSurface();
  const down = blankSurface();
  const side = blankSurface();
  for (let index = 0; index < indices.length; index += 3) {
    const corners = [0, 1, 2].map(offset => {
      const vertex = indices[index + offset]! * 3;
      return [positions[vertex]!, positions[vertex + 1]!, positions[vertex + 2]!];
    });
    const edgeA = [corners[1]![0] - corners[0]![0], corners[1]![1] - corners[0]![1], corners[1]![2] - corners[0]![2]];
    const edgeB = [corners[2]![0] - corners[0]![0], corners[2]![1] - corners[0]![1], corners[2]![2] - corners[0]![2]];
    let nx = edgeA[1]! * edgeB[2]! - edgeA[2]! * edgeB[1]!;
    let ny = edgeA[2]! * edgeB[0]! - edgeA[0]! * edgeB[2]!;
    let nz = edgeA[0]! * edgeB[1]! - edgeA[1]! * edgeB[0]!;
    const length = Math.hypot(nx, ny, nz) || 1;
    nx /= length; ny /= length; nz /= length;
    const target = ny > 0.65 ? up : ny < -0.65 ? down : side;
    pushTriangle(target, corners, [nx, ny, nz], point => (target === down ? [point[0]! / 0.14, point[2]! * 0.55] : [point[0]!, point[2]!]));
  }
  return { up, down, side };
}

function beamSurface(positions: number[], indices: number[]) {
  const nextPositions: number[] = [];
  const nextIndices: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  for (let index = 0; index < indices.length; index += 3) {
    const corners = [0, 1, 2].map(offset => {
      const vertex = indices[index + offset]! * 3;
      return [positions[vertex]!, positions[vertex + 1]!, positions[vertex + 2]!];
    });
    const edgeA = [corners[1]![0] - corners[0]![0], corners[1]![1] - corners[0]![1], corners[1]![2] - corners[0]![2]];
    const edgeB = [corners[2]![0] - corners[0]![0], corners[2]![1] - corners[0]![1], corners[2]![2] - corners[0]![2]];
    let nx = edgeA[1]! * edgeB[2]! - edgeA[2]! * edgeB[1]!;
    let ny = edgeA[2]! * edgeB[0]! - edgeA[0]! * edgeB[2]!;
    let nz = edgeA[0]! * edgeB[1]! - edgeA[1]! * edgeB[0]!;
    const length = Math.hypot(nx, ny, nz) || 1;
    nx /= length; ny /= length; nz /= length;
    const base = nextPositions.length / 3;
    const spanX = Math.abs(edgeA[0]!) + Math.abs(edgeB[0]!);
    const spanZ = Math.abs(edgeA[2]!) + Math.abs(edgeB[2]!);
    for (const point of corners) {
      nextPositions.push(point[0]!, point[1]!, point[2]!);
      normals.push(nx, ny, nz);
      const along = spanX >= spanZ ? point[0]! : point[2]!;
      const across = Math.abs(ny) > 0.65 ? (spanX >= spanZ ? point[2]! : point[0]!) : point[1]!;
      uvs.push(along * 1.6, across * 3);
    }
    nextIndices.push(base, base + 1, base + 2);
  }
  return { positions: nextPositions, indices: nextIndices, normals, uvs };
}

function color(hex: string): Color3 {
  const value = Number.parseInt(hex.slice(1), 16);
  return new Color3(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255);
}

function part(scene: Scene, parent: TransformNode, name: string, width: number, height: number, depth: number, x: number, y: number, z: number, material: StandardMaterial, outline: boolean): Mesh {
  const mesh = MeshBuilder.CreateBox(name, { width, height, depth }, scene);
  mesh.parent = parent;
  mesh.position.set(x, y, z);
  mesh.material = material;
  mesh.renderOutline = outline;
  mesh.outlineWidth = 0.02;
  mesh.outlineColor = new Color3(0.12, 0.31, 0.28);
  return mesh;
}

/** Display silhouettes stay inside the authored width, height, and depth. */
function furnish(scene: Scene, parent: TransformNode, asset: Asset, material: StandardMaterial, outline: boolean, created: StandardMaterial[]): void {
  const w = asset.width;
  const h = asset.height;
  const d = asset.depth;
  const add = (name: string, width: number, height: number, depth: number, x: number, y: number, z: number) => part(scene, parent, name, width, height, depth, x, y, z, material, outline);
  if (asset.kind === 'sofa') {
    add('seat', w * 0.92, h * 0.42, d * 0.78, 0, h * 0.21, d * 0.08);
    add('back', w * 0.92, h * 0.58, d * 0.18, 0, h * 0.71, -d * 0.38);
    add('arm-l', w * 0.1, h * 0.48, d * 0.78, -w * 0.45, h * 0.28, d * 0.06);
    add('arm-r', w * 0.1, h * 0.48, d * 0.78, w * 0.45, h * 0.28, d * 0.06);
  } else if (asset.kind === 'chair') {
    add('seat', w * 0.86, h * 0.16, d * 0.78, 0, h * 0.42, d * 0.04);
    add('back', w * 0.86, h * 0.46, d * 0.12, 0, h * 0.74, -d * 0.38);
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) add(`leg-${x}${z}`, w * 0.1, h * 0.4, d * 0.1, x * w * 0.34, h * 0.2, z * d * 0.32);
  } else if (asset.kind === 'table') {
    add('top', w, h * 0.12, d, 0, h * 0.94, 0);
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) add(`leg-${x}${z}`, Math.min(0.06, w * 0.08), h * 0.88, Math.min(0.06, d * 0.1), x * (w * 0.42), h * 0.44, z * (d * 0.38));
  } else if (asset.kind === 'bed') {
    add('base', w * 0.96, h * 0.55, d * 0.92, 0, h * 0.28, d * 0.02);
    add('head', w, h * 0.9, d * 0.08, 0, h * 0.45, -d * 0.46);
  } else if (asset.kind === 'plant') {
    const pot = MeshBuilder.CreateCylinder(`${parent.name}-pot`, { height: h * 0.22, diameter: w * 0.42, tessellation: 12 }, scene);
    pot.parent = parent;
    pot.position.y = h * 0.11;
    pot.material = material;
    const leaves = MeshBuilder.CreateSphere(`${parent.name}-leaves`, { diameter: w * 0.92, segments: 10 }, scene);
    leaves.parent = parent;
    leaves.position.y = h * 0.58;
    leaves.scaling.y = (h * 0.7) / (w * 0.92);
    const foliage = material.clone(`${parent.name}-foliage`);
    foliage.diffuseColor = new Color3(0.32, 0.46, 0.3);
    leaves.material = foliage;
    created.push(foliage);
  } else {
    add('body', w, h * 0.86, d, 0, h * 0.5, 0);
    add('plinth', w * 1.02, h * 0.08, d * 1.02, 0, h * 0.04, 0);
  }
}

function placeFurniture(scene: Scene, instance: Instance, asset: Asset, pose: WorldPose, material: StandardMaterial, outline: boolean, created: StandardMaterial[]): TransformNode {
  const root = new TransformNode(instance.id, scene);
  root.position.set(pose.x, pose.y, pose.z);
  root.rotation.y = pose.rotation * Math.PI / 180;
  root.scaling.setAll(pose.scale);
  furnish(scene, root, asset, material, outline, created);
  return root;
}

export function mountView(canvas: HTMLCanvasElement): ViewHandle {
  const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  scene.clearColor = new Color4(0.945, 0.93, 0.9, 1);
  const camera = new ArcRotateCamera('camera', -Math.PI / 2, 1.22, 26, new Vector3(2.2, 2, 0.6), scene);
  camera.attachControl(canvas, true);
  camera.lowerRadiusLimit = 2;
  camera.upperRadiusLimit = 80;
  camera.wheelPrecision = 40;
  camera.panningSensibility = 80;
  const fill = new HemisphericLight('fill', new Vector3(0.2, 1, 0.1), scene);
  fill.intensity = 0.92;
  fill.groundColor = new Color3(0.7, 0.66, 0.58);
  const sun = new DirectionalLight('sun', new Vector3(0.25, -0.9, 0.55), scene);
  sun.intensity = 0.62;
  const ground = MeshBuilder.CreateGround('ground', { width: 24, height: 24 }, scene);
  ground.position.y = -0.24;
  const groundMaterial = new StandardMaterial('ground', scene);
  groundMaterial.diffuseColor = new Color3(0.78, 0.8, 0.74);
  groundMaterial.specularColor = Color3.Black();
  ground.material = groundMaterial;
  const owned: Node[] = [];
  const materials: StandardMaterial[] = [];
  const wallMeshes = new Map<string, Mesh[]>();
  const accessoryMeshes = new Map<string, Mesh[]>();
  const siding = createSiding(scene);
  const concrete = createConcrete(scene);
  const wood = createWood(scene);
  const planks = createPlanks(scene);
  let currentProject: Project | null = null;
  let lookInside = false;
  let marker: TransformNode | null = null;
  const applyLookInside = () => {
    const forward = camera.getTarget().subtract(camera.position);
    const hidden = lookInside && currentProject ? nearestWallId(currentProject.walls, currentProject.nodes, { id: 'camera', x: camera.position.x, z: camera.position.z }, { id: 'view', x: forward.x, z: forward.z }) : null;
    for (const [id, meshes] of wallMeshes) {
      const visible = id !== hidden;
      for (const mesh of meshes) mesh.setEnabled(visible);
      for (const extra of accessoryMeshes.get(id) ?? []) extra.setEnabled(visible);
    }
    canvas.dataset.hiddenWall = hidden ?? '';
  };
  camera.onViewMatrixChangedObservable.add(applyLookInside);
  const resize = new ResizeObserver(() => engine.resize());
  resize.observe(canvas);
  engine.runRenderLoop(() => scene.render());

  return {
    update(project, geometry, selectedId, clip) {
      for (const node of owned) node.dispose();
      owned.length = 0;
      wallMeshes.clear();
      accessoryMeshes.clear();
      for (const material of materials) material.dispose(false, false);
      materials.length = 0;
      currentProject = project;
      scene.clipPlane = clip == null ? null : new Plane(0, 1, 0, -clip);
      const materialFor = (hex: string) => {
        const material = new StandardMaterial(hex, scene);
        material.diffuseColor = color(hex);
        material.specularColor = new Color3(0.03, 0.03, 0.03);
        material.backFaceCulling = false;
        material.twoSidedLighting = true;
        materials.push(material);
        return material;
      };
      const mark = (mesh: Mesh, id: string) => {
        mesh.renderOutline = id === selectedId;
        mesh.outlineWidth = 0.025;
        mesh.outlineColor = new Color3(0.12, 0.31, 0.28);
      };
      const paint = (id: string, surface: Surface, material: StandardMaterial): Mesh | undefined => {
        if (surface.indices.length === 0) return undefined;
        const mesh = new Mesh(id, scene);
        const vertexData = new VertexData();
        vertexData.positions = surface.positions;
        vertexData.indices = surface.indices;
        vertexData.normals = surface.normals;
        vertexData.uvs = surface.uvs;
        vertexData.applyToMesh(mesh);
        mesh.material = material;
        mark(mesh, id);
        owned.push(mesh);
        return mesh;
      };
      for (const data of geometry.meshes) {
        const plankCeiling = data.kind === 'slab' && project.slabs.find(item => item.id === data.id)?.ceiling === 'planks';
        if (plankCeiling) {
          const faces = slabFaces(data.positions, data.indices);
          const floor = materialFor(data.color);
          paint(data.id, faces.up, floor);
          paint(data.id, faces.side, floor);
          const ceiling = materialFor('#ffffff');
          ceiling.diffuseTexture = planks;
          paint(data.id, faces.down, ceiling);
          continue;
        }
        if (data.kind === 'wall') {
          const wall = project.walls.find(item => item.id === data.id);
          const normal = wall ? outwardNormal(project, wall) : undefined;
          const pieces: Mesh[] = [];
          if (wall && normal && wall.finish !== 'concrete') {
            const faces = splitWall(data.positions, data.indices, normal, 0.16);
            const exterior = materialFor(data.color);
            exterior.diffuseTexture = siding;
            const interior = materialFor(wall.interior ?? '#f4f1ea');
            for (const mesh of [paint(data.id, faces.outside, exterior), paint(data.id, faces.edge, exterior), paint(data.id, faces.inside, interior)]) {
              if (mesh) pieces.push(mesh);
            }
          } else {
            const surface = wallSurface(data.positions, data.indices, wall?.finish === 'concrete' ? 0.8 : 0.16);
            const material = materialFor(data.color);
            material.diffuseTexture = wall?.finish === 'concrete' ? concrete : siding;
            const mesh = paint(data.id, surface, material);
            if (mesh) pieces.push(mesh);
          }
          wallMeshes.set(data.id, pieces);
          continue;
        }
        const mesh = new Mesh(data.id, scene);
        const vertexData = new VertexData();
        const timber = data.kind === 'beam';
        if (timber) {
          const surface = beamSurface(data.positions, data.indices);
          vertexData.positions = surface.positions;
          vertexData.indices = surface.indices;
          vertexData.normals = surface.normals;
          vertexData.uvs = surface.uvs;
        } else {
          vertexData.positions = data.positions;
          vertexData.indices = data.indices;
          const normals: number[] = [];
          VertexData.ComputeNormals(data.positions, data.indices, normals);
          vertexData.normals = normals;
        }
        vertexData.applyToMesh(mesh);
        const material = materialFor(timber ? '#ffffff' : data.color);
        if (timber) material.diffuseTexture = wood;
        mesh.material = material;
        mark(mesh, data.id);
        owned.push(mesh);
      }
      const trim = materialFor('#f4f1ea');
      wallAccessories(project).forEach((box, index) => {
        const mesh = MeshBuilder.CreateBox(`trim-${box.wallId}-${index}`, { width: box.size[0], height: box.size[1], depth: box.size[2] }, scene);
        mesh.position.set(box.center[0], box.center[1], box.center[2]);
        const rotation = Vector3.Zero();
        Vector3.RotationFromAxisToRef(new Vector3(...box.axisX), new Vector3(...box.axisY), new Vector3(...box.axisZ), rotation);
        mesh.rotation = rotation;
        mesh.material = trim;
        const list = accessoryMeshes.get(box.wallId) ?? [];
        list.push(mesh);
        accessoryMeshes.set(box.wallId, list);
        owned.push(mesh);
      });
      for (const instance of project.instances) {
        const asset = project.assets.find(item => item.id === instance.assetId);
        if (!asset || asset.file) continue;
        owned.push(placeFurniture(scene, instance, asset, instanceWorldPose(project, instance), materialFor(asset.color), instance.id === selectedId, materials));
      }
      const points = project.nodes.length ? project.nodes : [{ x: 0, z: 0 }];
      const cx = (Math.min(...points.map(point => point.x)) + Math.max(...points.map(point => point.x))) / 2;
      const cz = (Math.min(...points.map(point => point.z)) + Math.max(...points.map(point => point.z))) / 2;
      const lowestSlab = project.slabs.reduce((level, slab) => Math.min(level, slab.elevation - slab.thickness), 0);
      const lowest = project.walls.reduce((level, wall) => Math.min(level, wall.base), lowestSlab);
      ground.position.set(cx, lowest - 0.04, cz);
      applyLookInside();
    },
    setLookInside(enabled) {
      lookInside = enabled;
      applyLookInside();
    },
    async loadMarker(url) {
      marker?.dispose();
      const root = new TransformNode('marker', scene);
      root.position.set(4, 0, 1.2);
      marker = root;
      const result = await SceneLoader.ImportMeshAsync('', '', new URL(url, window.location.href).href, scene);
      let min = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
      let max = new Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
      for (const mesh of result.meshes) {
        if (!mesh.parent) mesh.parent = root;
        mesh.computeWorldMatrix(true);
        const bounds = mesh.getBoundingInfo().boundingBox;
        min = Vector3.Minimize(min, bounds.minimumWorld);
        max = Vector3.Maximize(max, bounds.maximumWorld);
      }
      return { width: max.x - min.x, height: max.y - min.y, depth: max.z - min.z };
    },
    dispose() {
      resize.disconnect();
      scene.dispose();
      engine.dispose();
    },
  };
}
