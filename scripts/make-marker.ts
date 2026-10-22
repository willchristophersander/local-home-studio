import { mkdir, mkdtemp, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { importLocalAsset } from '../src/assets/index';

const positions: number[] = [];
const uvs: number[] = [];
const indices: number[] = [];
const faces = [
  [[-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, 1, 0.5], [-0.5, 1, 0.5]],
  [[0.5, 0, -0.5], [-0.5, 0, -0.5], [-0.5, 1, -0.5], [0.5, 1, -0.5]],
  [[-0.5, 1, 0.5], [0.5, 1, 0.5], [0.5, 1, -0.5], [-0.5, 1, -0.5]],
  [[-0.5, 0, -0.5], [0.5, 0, -0.5], [0.5, 0, 0.5], [-0.5, 0, 0.5]],
  [[0.5, 0, 0.5], [0.5, 0, -0.5], [0.5, 1, -0.5], [0.5, 1, 0.5]],
  [[-0.5, 0, -0.5], [-0.5, 0, 0.5], [-0.5, 1, 0.5], [-0.5, 1, -0.5]],
];
for (const face of faces) {
  const offset = positions.length / 3;
  for (const [index, vertex] of face.entries()) {
    positions.push(...vertex);
    uvs.push(index === 1 || index === 2 ? 1 : 0, index >= 2 ? 1 : 0);
  }
  indices.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3);
}

async function main(): Promise<void> {
const source = await mkdtemp(path.join(tmpdir(), 'marker-source-'));
const staged = await mkdtemp(path.join(tmpdir(), 'marker-import-'));
const doc = new Document();
const buffer = doc.createBuffer();
const position = doc.createAccessor().setType('VEC3').setArray(new Float32Array(positions)).setBuffer(buffer);
const uv = doc.createAccessor().setType('VEC2').setArray(new Float32Array(uvs)).setBuffer(buffer);
const index = doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(indices)).setBuffer(buffer);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const material = doc.createMaterial('paint').setBaseColorTexture(doc.createTexture('swatch').setMimeType('image/png').setImage(png));
const mesh = doc.createMesh().addPrimitive(doc.createPrimitive().setAttribute('POSITION', position).setAttribute('TEXCOORD_0', uv).setIndices(index).setMaterial(material));
doc.createScene().addChild(doc.createNode().setMesh(mesh));
await new NodeIO().write(path.join(source, 'marker.gltf'), doc);
const asset = await importLocalAsset(path.join(source, 'marker.gltf'), staged);
const output = path.resolve('public');
await mkdir(output, { recursive: true });
await copyFile(path.join(staged, asset.file!), path.join(output, 'marker-cube.glb'));
await rm(source, { recursive: true, force: true });
await rm(staged, { recursive: true, force: true });
console.log(JSON.stringify({ width: asset.width, height: asset.height, depth: asset.depth, file: 'public/marker-cube.glb' }));
}
main();
