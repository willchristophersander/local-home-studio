import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Document, getBounds, NodeIO } from '@gltf-transform/core';
import { validateBytes } from 'gltf-validator';
import { checkProviderURL, downloadPolyHaven, importLocalAsset, listPolyHaven, parsePolyHavenManifest, safeRelativeAssetPath, verifyIntegrity } from '../src/assets';

const temporary: string[] = [];
async function directory(): Promise<string> { const value = await mkdtemp(path.join(tmpdir(), 'home-assets-test-')); temporary.push(value); return value; }
afterEach(async () => { await Promise.all(temporary.splice(0).map(p => rm(p, { recursive: true, force: true }))); });

async function fixture(root: string, binary = false): Promise<string> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const position = doc.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 3])).setBuffer(buffer);
  const index = doc.createAccessor().setType('SCALAR').setArray(new Uint16Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3])).setBuffer(buffer);
  const mesh = doc.createMesh().addPrimitive(doc.createPrimitive().setAttribute('POSITION', position).setIndices(index));
  doc.createScene().addChild(doc.createNode().setMesh(mesh));
  const file = path.join(root, binary ? 'fixture.glb' : 'fixture.gltf');
  await new NodeIO().write(file, doc);
  return file;
}

describe('asset resource boundaries', () => {
  it.each(['../private.bin', '%2e%2e/private.bin', '%252e%252e/private.bin', '/tmp/private.bin', 'C:/private.bin', 'file:///private.bin', 'https://example.com/private.bin', 'x\\private.bin', 'x//private.bin', 'textures/./map.jpg', 'x%00.bin'])('rejects unsafe URI %s', uri => {
    expect(() => safeRelativeAssetPath(uri)).toThrow();
  });
  it('allows a relative percent-encoded filename', () => { expect(safeRelativeAssetPath('textures/warm%20wood.jpg')).toBe('textures/warm wood.jpg'); });
  it.each(['http://dl.polyhaven.org/model.gltf', 'https://dl.polyhaven.org.evil.test/model.gltf', 'https://user@dl.polyhaven.org/model.gltf', 'https://127.0.0.1/model.gltf', 'https://dl.polyhaven.org:8443/model.gltf'])('rejects unauthorized provider URL %s', uri => {
    expect(() => checkProviderURL(uri)).toThrow();
  });
  it('validates transfer length and checksum', () => {
    const bytes = Buffer.from('fixture bytes');
    const md5 = createHash('md5').update(bytes).digest('hex');
    expect(() => verifyIntegrity(bytes, { size: bytes.length, md5 })).not.toThrow();
    expect(() => verifyIntegrity(bytes, { size: 1, md5 })).toThrow(/length/);
    expect(() => verifyIntegrity(bytes, { size: bytes.length, md5: '0'.repeat(32) })).toThrow(/checksum/);
  });
  it('rejects unsafe manifest dependencies before download', () => {
    const file = { url: 'https://dl.polyhaven.org/model.gltf', size: 10, md5: '0'.repeat(32) };
    expect(() => parsePolyHavenManifest({ gltf: { '1k': { gltf: { ...file, include: { '../escape.bin': file } } } } })).toThrow(/Unsafe/);
    expect(() => parsePolyHavenManifest({ gltf: { '1k': { gltf: { ...file, include: { 'MODEL.gltf': file } } } } })).toThrow(/Duplicate/);
  });
});

describe('local import', () => {
  it.each([false, true])('produces validated, self-contained, bottom-centered GLB from binary=%s', async binary => {
    const source = await directory();
    const destination = await directory();
    const asset = await importLocalAsset(await fixture(source, binary), destination);
    expect(asset.file).toMatch(/^[a-f0-9]{64}\.glb$/);
    expect([asset.width, asset.height, asset.depth]).toEqual([1, 2, 3]);
    expect(asset.aiAllowed).toBe(false);
    expect(asset.license).toMatch(/rights not verified/);
    const bytes = await readFile(path.join(destination, asset.file!));
    expect(createHash('sha256').update(bytes).digest('hex') + '.glb').toBe(asset.file);
    const report = await validateBytes(bytes, { format: 'glb' });
    expect(report.issues.numErrors).toBe(0);
    const imported = await new NodeIO().readBinary(bytes);
    expect(getBounds(imported.getRoot().listScenes()[0])).toEqual({ min: [-0.5, 0, -1.5], max: [0.5, 2, 1.5] });
    await rm(source, { recursive: true, force: true });
    await expect(new NodeIO().read(path.join(destination, asset.file!))).resolves.toBeDefined();
    expect((await readdir(destination)).some(f => f.startsWith('.install-'))).toBe(false);
  });
  it('rejects symbolic link dependencies and leaves no installed asset', async () => {
    const source = await directory();
    const outside = await directory();
    const destination = await directory();
    const file = await fixture(source);
    const json = JSON.parse(await readFile(file, 'utf8'));
    const resource = path.join(source, json.buffers[0].uri);
    const bytes = await readFile(resource);
    await writeFile(path.join(outside, 'outside.bin'), bytes);
    await rm(resource);
    await symlink(path.join(outside, 'outside.bin'), resource);
    await expect(importLocalAsset(file, destination)).rejects.toThrow(/Symbolic/);
    expect(await readdir(destination)).toEqual([]);
  });
  it('rejects a network URI without invoking fetch', async () => {
    const source = await directory();
    const destination = await directory();
    const file = await fixture(source);
    const json = JSON.parse(await readFile(file, 'utf8'));
    json.buffers[0].uri = 'https://example.invalid/secret.bin';
    await writeFile(file, JSON.stringify(json));
    await expect(importLocalAsset(file, destination)).rejects.toThrow(/external/);
    expect(await readdir(destination)).toEqual([]);
  });
  it('rejects traversal, missing resources, malformed and unsupported assets', async () => {
    const source = await directory();
    const destination = await directory();
    const file = await fixture(source);
    const json = JSON.parse(await readFile(file, 'utf8'));
    json.buffers[0].uri = '../escaped.bin';
    await writeFile(file, JSON.stringify(json));
    await expect(importLocalAsset(file, destination)).rejects.toThrow(/Unsafe/);
    json.buffers[0].uri = 'missing.bin';
    await writeFile(file, JSON.stringify(json));
    await expect(importLocalAsset(file, destination)).rejects.toThrow();
    await writeFile(file, '{ invalid json');
    await expect(importLocalAsset(file, destination)).rejects.toThrow(/Invalid glTF/);
    const bad = path.join(source, 'broken.glb');
    await writeFile(bad, Buffer.from('not a GLB'));
    await expect(importLocalAsset(bad, destination)).rejects.toThrow(/Invalid GLB/);
    await expect(importLocalAsset(path.join(source, 'model.blend'), destination)).rejects.toThrow(/Other formats require conversion/);
    expect(await readdir(destination)).toEqual([]);
  });
  it('rejects unsupported required compression and pathological accessor size before parser allocation', async () => {
    const source = await directory();
    const destination = await directory();
    const file = await fixture(source);
    const json = JSON.parse(await readFile(file, 'utf8'));
    json.extensionsRequired = ['KHR_draco_mesh_compression'];
    await writeFile(file, JSON.stringify(json));
    await expect(importLocalAsset(file, destination)).rejects.toThrow(/Unsupported glTF extension/);
    delete json.extensionsRequired;
    json.accessors[0].count = 9_000_000;
    await writeFile(file, JSON.stringify(json));
    await expect(importLocalAsset(file, destination)).rejects.toThrow(/geometry import budget/);
  });
});

  it('keeps a PNG texture inside the normalized GLB', async () => {
    const source = await directory();
    const destination = await directory();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const doc = new Document();
    const buffer = doc.createBuffer();
    const position = doc.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1])).setBuffer(buffer);
    const uv = doc.createAccessor().setType('VEC2').setArray(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1])).setBuffer(buffer);
    const index = doc.createAccessor().setType('SCALAR').setArray(new Uint16Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3])).setBuffer(buffer);
    const texture = doc.createTexture('swatch').setMimeType('image/png').setImage(png);
    const material = doc.createMaterial('paint').setBaseColorTexture(texture);
    const mesh = doc.createMesh().addPrimitive(doc.createPrimitive().setAttribute('POSITION', position).setAttribute('TEXCOORD_0', uv).setIndices(index).setMaterial(material));
    doc.createScene().addChild(doc.createNode().setMesh(mesh));
    const file = path.join(source, 'textured.gltf');
    await new NodeIO().write(file, doc);
    const asset = await importLocalAsset(file, destination);
    const imported = await new NodeIO().readBinary(await readFile(path.join(destination, asset.file!)));
    expect(imported.getRoot().listTextures()).toHaveLength(1);
    expect(imported.getRoot().listTextures()[0]!.getMimeType()).toBe('image/png');
  });

// Explicit opt-in: no network, provider dependency, or bulk downloads in the ordinary test suite.
it.runIf(process.env.LIVE_ASSET_TEST === '1')('live Poly Haven catalog and modest wooden bowl import', async () => {
  const results = await listPolyHaven();
  expect(results.find(result => result.id === 'wooden_bowl_01')).toBeDefined();
  const destination = process.env.LIVE_ASSET_DESTINATION || await directory();
  const asset = await downloadPolyHaven('wooden_bowl_01', destination);
  expect(asset.license).toBe('CC0-1.0');
  expect(asset.aiAllowed).toBe(true);
  expect(asset.width).toBeGreaterThan(0.25);
  expect(asset.width).toBeLessThan(0.4);
  expect(asset.height).toBeGreaterThan(0.05);
  const report = await validateBytes(await readFile(path.join(destination, asset.file!)), { format: 'glb' });
  expect(report.issues.numErrors).toBe(0);
  console.log('Live asset evidence:', JSON.stringify(asset));
}, 120_000);
