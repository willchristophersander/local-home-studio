import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { getBounds, ImageUtils, NodeIO, type JSONDocument } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { validateBytes } from 'gltf-validator';
import type { Asset, CatalogItem } from '../shared/model';

export const IMPORT_LIMITS = {
  maxFiles: 64,
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxJSONBytes: 8 * 1024 * 1024,
  maxJSONDepth: 64,
  maxNodes: 10_000,
  maxAccessorElements: 3_000_000,
  maxTriangles: 1_000_000,
  maxTextureEdge: 8192,
  maxTexturePixels: 32_000_000,
  maxTotalTexturePixels: 64_000_000,
} as const;

const APP_AGENT = 'LocalHomeStudio/0.1 (desktop asset importer)';
const API = 'https://api.polyhaven.com';
const MATERIAL_EXTENSIONS = new Set([
  'KHR_materials_unlit', 'KHR_texture_transform', 'KHR_materials_clearcoat',
  'KHR_materials_emissive_strength', 'KHR_materials_ior', 'KHR_materials_iridescence',
  'KHR_materials_sheen', 'KHR_materials_specular', 'KHR_materials_transmission',
  'KHR_materials_volume', 'KHR_materials_anisotropy',
]);
type JSONValue = Record<string, any>;
type ProviderFile = { url: string; size: number; md5: string };
type ManifestFile = ProviderFile & { relative: string };
type Provenance = { name: string; source?: string; author?: string; license?: string; aiAllowed: boolean; providerId?: string; filesHash?: string };

function object(value: unknown, label: string): JSONValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as JSONValue;
}

/** URI paths are decoded once, validated, and never passed to a network-capable loader. */
export function safeRelativeAssetPath(uri: string): string {
  if (typeof uri !== 'string' || !uri || uri.length > 1024) throw new Error('Invalid asset resource path.');
  let decoded: string;
  try { decoded = decodeURIComponent(uri); } catch { throw new Error('Malformed asset resource path encoding.'); }
  if (/[\\\0:%?#]/.test(decoded) || decoded.startsWith('/') || decoded.split('/').some(p => !p || p === '.' || p === '..')) {
    throw new Error(`Unsafe or external asset resource path: ${uri}`);
  }
  return decoded;
}

export function checkProviderURL(input: string, role: 'api' | 'file' | 'thumbnail' = 'file'): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('Provider returned an invalid URL.'); }
  const hosts = role === 'api' ? ['api.polyhaven.com'] : role === 'thumbnail' ? ['cdn.polyhaven.com'] : ['dl.polyhaven.org', 'dl.polyhaven.com'];
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !hosts.includes(url.hostname)) {
    throw new Error('Provider resource URL is not an approved HTTPS host.');
  }
  return url;
}

/** Streaming byte cap also applies when Content-Length is missing or untruthful. */
async function fetchBounded(input: string, role: 'api' | 'file', maxBytes: number): Promise<Uint8Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    let url = checkProviderURL(input, role);
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await fetch(url, { headers: { 'User-Agent': APP_AGENT }, signal: controller.signal, redirect: 'manual' });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location || redirects === 3) throw new Error('Invalid or excessive provider redirect.');
        url = checkProviderURL(new URL(location, url).href, role);
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Poly Haven request failed (${response.status}). Try again later.`); }
      const length = Number(response.headers.get('content-length') ?? 0);
      if (!Number.isFinite(length) || length < 0 || length > maxBytes) { await response.body?.cancel(); throw new Error('Provider response exceeds the import byte limit.'); }
      if (!response.body) throw new Error('Provider returned an empty response.');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) throw new Error('Provider response exceeds the import byte limit.');
          chunks.push(value);
        }
      } catch (error) { await reader.cancel(); throw error; }
      const result = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
      return result;
    }
    throw new Error('Provider redirect failed.');
  } finally { clearTimeout(timer); }
}

async function providerJSON(endpoint: string): Promise<JSONValue> {
  const bytes = await fetchBounded(`${API}/${endpoint}`, 'api', 16 * 1024 * 1024);
  try { return object(JSON.parse(new TextDecoder().decode(bytes)), 'Provider response'); }
  catch { throw new Error('Poly Haven returned invalid catalog data.'); }
}

let catalogCache: { time: number; data: JSONValue } | undefined;
async function catalog(): Promise<JSONValue> {
  if (!catalogCache || Date.now() - catalogCache.time > 3_600_000) {
    catalogCache = { time: Date.now(), data: await providerJSON('assets?t=models') };
  }
  return catalogCache.data;
}

function sourceURL(id: string): string { return `https://polyhaven.com/a/${encodeURIComponent(id)}`; }
function author(metadata: JSONValue): string { return metadata.authors && typeof metadata.authors === 'object' ? Object.keys(metadata.authors).join(', ') : 'Poly Haven contributors'; }

export async function listPolyHaven(): Promise<CatalogItem[]> {
  const data = await catalog();
  return Object.entries(data).flatMap(([id, raw]) => {
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(id) || !raw || typeof raw !== 'object' || typeof raw.name !== 'string') return [];
    const item = raw as JSONValue;
    let thumbnail = '';
    if (typeof item.thumbnail_url === 'string') {
      try { thumbnail = checkProviderURL(item.thumbnail_url, 'thumbnail').href; } catch { /* omit unsafe provider image */ }
    }
    return [{ id, name: item.name.slice(0, 200), thumbnail, source: sourceURL(id), author: author(item),
      dimensions: Array.isArray(item.dimensions) && item.dimensions.length === 3 && item.dimensions.every((n: unknown) => typeof n === 'number' && n > 0 && Number.isFinite(n))
        ? item.dimensions.map((n: number) => n / 1000) : undefined }];
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function providerFile(value: unknown): ProviderFile {
  const file = object(value, 'Download file');
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > IMPORT_LIMITS.maxFileBytes || typeof file.md5 !== 'string' || !/^[a-f0-9]{32}$/i.test(file.md5)) {
    throw new Error('Provider file has invalid size or checksum.');
  }
  const url = checkProviderURL(file.url).href;
  return { url, size: file.size, md5: file.md5.toLowerCase() };
}

export function parsePolyHavenManifest(data: unknown): { entry: string; files: ManifestFile[] } {
  const variants = object(object(data, 'File manifest').gltf, 'glTF variants');
  const resolution = ['1k', '2k'].find(key => variants[key]?.gltf);
  if (!resolution) throw new Error('This model has no supported 1k or 2k glTF download.');
  const entryData = object(variants[resolution].gltf, 'glTF rendition');
  const primary = providerFile(entryData);
  const entry = safeRelativeAssetPath(new URL(primary.url).pathname.split('/').at(-1)!);
  if (!entry.endsWith('.gltf')) throw new Error('Provider main file is not glTF.');
  const includes = object(entryData.include ?? {}, 'glTF dependencies');
  const files = [{ ...primary, relative: entry }, ...Object.entries(includes).map(([uri, info]) => ({ ...providerFile(info), relative: safeRelativeAssetPath(uri) }))];
  if (files.length > IMPORT_LIMITS.maxFiles || files.reduce((sum, f) => sum + f.size, 0) > IMPORT_LIMITS.maxTotalBytes) throw new Error('Model exceeds the supported import size.');
  // Case-insensitive collision checks also protect default macOS filesystems.
  if (new Set(files.map(f => f.relative.toLowerCase())).size !== files.length) throw new Error('Duplicate provider resource paths.');
  return { entry, files };
}

export function verifyIntegrity(bytes: Uint8Array, expected: { size: number; md5: string }): void {
  if (bytes.length !== expected.size) throw new Error('Downloaded file length does not match the manifest.');
  const hash = createHash('md5').update(bytes).digest();
  const expectedHash = Buffer.from(expected.md5, 'hex');
  if (expectedHash.length !== hash.length || !timingSafeEqual(hash, expectedHash)) throw new Error('Downloaded file checksum does not match the manifest.');
}

async function containedRead(root: string, relative: string): Promise<Uint8Array> {
  const safe = safeRelativeAssetPath(relative);
  let current = root;
  for (const segment of safe.split('/')) {
    current = path.join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Symbolic links are not allowed in asset resources.');
  }
  const resolved = await realpath(current);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error('Asset dependency escapes its selected directory.');
  const handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > IMPORT_LIMITS.maxFileBytes) throw new Error('Asset resource is empty, not a file, or exceeds the byte limit.');
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size || bytes.length > IMPORT_LIMITS.maxFileBytes) throw new Error('Asset changed during import.');
    return bytes;
  } finally { await handle.close(); }
}

function checkTree(value: unknown): void {
  const pending: Array<[unknown, number]> = [[value, 0]];
  let count = 0;
  while (pending.length) {
    const [item, depth] = pending.pop()!;
    if (++count > 1_000_000 || depth > IMPORT_LIMITS.maxJSONDepth) throw new Error('glTF JSON exceeds structure limits.');
    if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('glTF contains a nonfinite number.');
    if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('glTF contains an unsafe object key.');
        pending.push([child, depth + 1]);
      }
    }
  }
}

function checkGLTF(json: JSONValue, selfContained: boolean): string[] {
  checkTree(json);
  if (json.asset?.version !== '2.0') throw new Error('Only glTF 2.0 assets are supported.');
  if (json.animations?.length || json.skins?.length) throw new Error('Animated or skinned models are not supported by this static furniture importer.');
  if (!Array.isArray(json.scenes) || json.scenes.length !== 1 || !Array.isArray(json.nodes) || json.nodes.length > IMPORT_LIMITS.maxNodes) throw new Error('Import requires one scene within the supported node limit.');
  for (const extension of [...(json.extensionsRequired ?? []), ...(json.extensionsUsed ?? [])]) {
    if (!MATERIAL_EXTENSIONS.has(extension)) throw new Error(`Unsupported glTF extension: ${extension}`);
  }
  let elements = 0;
  for (const accessor of json.accessors ?? []) {
    if (!Number.isSafeInteger(accessor.count) || accessor.count < 0) throw new Error('Invalid glTF accessor count.');
    elements += accessor.count;
  }
  if (elements > IMPORT_LIMITS.maxAccessorElements) throw new Error('Model exceeds the geometry import budget.');
  let triangles = 0;
  for (const mesh of json.meshes ?? []) for (const primitive of mesh.primitives ?? []) {
    if ((primitive.mode ?? 4) !== 4 || primitive.targets?.length) throw new Error('Only static triangle meshes are supported.');
    triangles += (json.accessors?.[primitive.indices ?? primitive.attributes?.POSITION]?.count ?? 0) / 3;
  }
  if (triangles > IMPORT_LIMITS.maxTriangles) throw new Error('Model exceeds the triangle limit.');
  const uris: string[] = [];
  for (const resource of [...(json.buffers ?? []), ...(json.images ?? [])]) {
    if (resource.uri !== undefined) {
      if (selfContained) throw new Error('GLB files must be self-contained; external resources are not allowed.');
      safeRelativeAssetPath(resource.uri);
      uris.push(resource.uri);
    }
  }
  if (uris.length + 1 > IMPORT_LIMITS.maxFiles) throw new Error('Model has too many dependencies.');
  return [...new Set(uris)];
}

function extractGLBJSON(bytes: Uint8Array): JSONValue {
  const buffer = Buffer.from(bytes);
  if (buffer.length < 20 || buffer.readUInt32LE(0) !== 0x46546c67 || buffer.readUInt32LE(4) !== 2 || buffer.readUInt32LE(8) !== buffer.length || buffer.readUInt32LE(16) !== 0x4e4f534a) throw new Error('Invalid GLB header.');
  const length = buffer.readUInt32LE(12);
  if (length > IMPORT_LIMITS.maxJSONBytes || 20 + length > bytes.length) throw new Error('Invalid or oversized GLB JSON chunk.');
  try { return object(JSON.parse(buffer.subarray(20, 20 + length).toString('utf8')), 'glTF JSON'); }
  catch { throw new Error('Invalid GLB JSON.'); }
}

async function normalize(filepath: string): Promise<{ binary: Uint8Array; width: number; height: number; depth: number; warnings: string[] }> {
  const extension = path.extname(filepath).toLowerCase();
  if (!['.gltf', '.glb'].includes(extension)) throw new Error('Choose a static glTF 2.0 (.gltf) or binary glTF (.glb) file. Other formats require conversion.');
  if ((await lstat(filepath)).isSymbolicLink()) throw new Error('Symbolic links are not supported for asset files.');
  const root = await realpath(path.dirname(filepath));
  const bytes = await containedRead(root, path.basename(filepath));
  let json: JSONValue;
  if (extension === '.glb') json = extractGLBJSON(bytes);
  else {
    if (bytes.length > IMPORT_LIMITS.maxJSONBytes) throw new Error('glTF JSON exceeds the byte limit.');
    try { json = object(JSON.parse(new TextDecoder().decode(bytes)), 'glTF JSON'); }
    catch { throw new Error('Invalid glTF JSON.'); }
  }
  const resources: Record<string, Uint8Array> = Object.create(null);
  let totalBytes = bytes.length;
  for (const uri of checkGLTF(json, extension === '.glb')) {
    const resource = await containedRead(root, safeRelativeAssetPath(uri));
    totalBytes += resource.length;
    if (totalBytes > IMPORT_LIMITS.maxTotalBytes) throw new Error('Model and dependencies exceed the import byte limit.');
    resources[uri] = resource;
  }
  const report = await validateBytes(bytes, {
    format: extension === '.glb' ? 'glb' : 'gltf', maxIssues: 40, writeTimestamp: false,
    externalResourceFunction: async uri => {
      safeRelativeAssetPath(uri);
      if (!resources[uri]) throw new Error('Unresolved asset resource.');
      return resources[uri];
    },
  });
  if (report.issues.numErrors) throw new Error(`Invalid glTF: ${report.issues.messages.filter(m => m.severity === 0).slice(0, 3).map(m => m.message).join('; ')}`);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const jsonDoc = (extension === '.glb' ? await io.binaryToJSON(bytes) : { json: json as JSONDocument['json'], resources }) as JSONDocument;
  const doc = await io.readJSON(jsonDoc);
  let texturePixels = 0;
  for (const texture of doc.getRoot().listTextures()) {
    const image = texture.getImage();
    const mime = texture.getMimeType();
    if (!image || !['image/png', 'image/jpeg'].includes(mime)) throw new Error('Only PNG and JPEG textures are supported.');
    const size = ImageUtils.getSize(image, mime);
    if (!size || size.some(n => !Number.isSafeInteger(n) || n < 1 || n > IMPORT_LIMITS.maxTextureEdge) || size[0] * size[1] > IMPORT_LIMITS.maxTexturePixels) throw new Error('Invalid or oversized model texture.');
    texturePixels += size[0] * size[1];
    if (texturePixels > IMPORT_LIMITS.maxTotalTexturePixels) throw new Error('Model exceeds the total texture memory budget.');
  }
  const scene = doc.getRoot().listScenes()[0];
  const { min, max } = getBounds(scene);
  const dimensions = max.map((value, i) => value - min[i]);
  if (![...min, ...max, ...dimensions].every(Number.isFinite) || dimensions.some(n => n <= 0 || n > 10_000)) throw new Error('Model has empty, flat, or unsupported bounds.');
  const origin = doc.createNode('Local Home Studio placement origin').setTranslation([-(min[0] + max[0]) / 2, -min[1], -(min[2] + max[2]) / 2]);
  for (const child of [...scene.listChildren()]) { scene.removeChild(child); origin.addChild(child); }
  scene.addChild(origin);
  // A GLB has one binary buffer. Provider glTF may use several.
  const buffers = doc.getRoot().listBuffers();
  const target = buffers[0] ?? doc.createBuffer();
  for (const accessor of doc.getRoot().listAccessors()) accessor.setBuffer(target);
  for (const buffer of buffers.slice(1)) buffer.dispose();
  const binary = await io.writeBinary(doc);
  if (binary.length > IMPORT_LIMITS.maxTotalBytes) throw new Error('Normalized asset exceeds the import byte limit.');
  const finalReport = await validateBytes(binary, { format: 'glb', maxIssues: 20, writeTimestamp: false });
  if (finalReport.issues.numErrors) throw new Error('Normalized GLB failed validation; no asset was installed.');
  return { binary, width: dimensions[0], height: dimensions[1], depth: dimensions[2], warnings: report.issues.messages.filter(m => m.severity === 1).map(m => m.message) };
}

async function install(filepath: string, destinationDir: string, provenance: Provenance): Promise<Asset> {
  const result = await normalize(filepath);
  const hash = createHash('sha256').update(result.binary).digest('hex');
  const file = `${hash}.glb`;
  const asset: Asset = { id: `asset-${hash}`, kind: 'glb', name: provenance.name, file, width: result.width, height: result.height, depth: result.depth, color: '#c6bba9', source: provenance.source, author: provenance.author, license: provenance.license, aiAllowed: provenance.aiAllowed };
  await mkdir(destinationDir, { recursive: true });
  const stage = await mkdtemp(path.join(destinationDir, '.install-'));
  try {
    const tempFile = path.join(stage, file);
    const handle = await open(tempFile, 'wx');
    try { await handle.writeFile(result.binary); await handle.sync(); } finally { await handle.close(); }
    const sidecar = { schemaVersion: 1, asset, provenance, sha256: hash, importedAt: new Date().toISOString(), warnings: result.warnings, transform: 'bottom-center origin; original meter scale preserved' };
    await writeFile(path.join(stage, `${hash}.json`), JSON.stringify(sidecar, null, 2), { flag: 'wx' });
    // The GLB is complete before any caller can add its reference to a project.
    await rename(tempFile, path.join(destinationDir, file));
    await rename(path.join(stage, `${hash}.json`), path.join(destinationDir, `${hash}.json`));
    return asset;
  } finally { await rm(stage, { recursive: true, force: true }); }
}

export async function importLocalAsset(filepath: string, destinationDir: string): Promise<Asset> {
  return install(filepath, destinationDir, { name: path.basename(filepath, path.extname(filepath)).slice(0, 200), license: 'User supplied — rights not verified', aiAllowed: false });
}

export async function downloadPolyHaven(id: string, destinationDir: string): Promise<Asset> {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(id)) throw new Error('Invalid Poly Haven asset identifier.');
  const metadata = object((await catalog())[id], 'Catalog model');
  const manifest = parsePolyHavenManifest(await providerJSON(`files/${encodeURIComponent(id)}`));
  await mkdir(destinationDir, { recursive: true });
  const stage = await mkdtemp(path.join(destinationDir, '.download-'));
  try {
    for (const file of manifest.files) {
      const bytes = await fetchBounded(file.url, 'file', file.size);
      verifyIntegrity(bytes, file);
      const destination = path.join(stage, file.relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, bytes, { flag: 'wx' });
    }
    return await install(path.join(stage, manifest.entry), destinationDir, {
      name: String(metadata.name).slice(0, 200), source: sourceURL(id), author: author(metadata),
      license: 'CC0-1.0', aiAllowed: true, providerId: id,
      filesHash: typeof metadata.files_hash === 'string' ? metadata.files_hash : undefined,
    });
  } finally { await rm(stage, { recursive: true, force: true }); }
}
