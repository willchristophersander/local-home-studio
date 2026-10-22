import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { CoreError } from '../core/schema';
import { MemoryStore } from '../core/memory';
import { buildGeometry } from '../geometry';
import { emptyRoomProject, reconcileBrief, roomSlug, roomTransaction, sideOfWall, type LockedDimension } from './draft-room';
import { parseRoomBrief, type RoomSide } from './room-brief';

const lockSchema = z.strictObject({
  property: z.enum(['width', 'depth', 'height', 'floorElevation']),
  valueM: z.number().finite(),
});
const caseSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  locked: z.array(lockSchema),
  evidence: z.array(z.strictObject({
    file: z.string().min(1),
    kind: z.enum(['metric', 'style', 'walkthrough']),
    note: z.string().max(400).optional(),
  })),
  metric: z.boolean().optional(),
});
const expectedSchema = z.strictObject({
  widthM: z.number().finite(),
  depthM: z.number().finite(),
  heightM: z.number().finite(),
  floorElevationM: z.number().finite(),
  toleranceM: z.number().positive(),
  openings: z.array(z.strictObject({
    wall: z.enum(['south', 'east', 'north', 'west']),
    kind: z.enum(['door', 'window']),
    widthM: z.number().positive(),
  })),
  overridden: z.array(z.string()),
  geometryCodes: z.array(z.string()),
  mustReject: z.boolean(),
  diagnosticCode: z.string().min(1).optional(),
  unseenIncludes: z.array(z.string()).optional(),
});
const runSchema = z.strictObject({
  caseId: z.string().min(1),
  prompt: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  live: z.boolean(),
});

export interface ObservedOpening {
  wall: RoomSide;
  kind: 'door' | 'window';
  widthM: number;
  offsetM: number;
  sillM: number;
  heightM: number;
}

export interface BriefScore {
  caseId: string;
  passed: boolean;
  live: boolean;
  prompt: string;
  provider: string;
  model: string;
  overridden: string[];
  diagnostics: { code: string; message: string }[];
  widthM: number | null;
  depthM: number | null;
  heightM: number | null;
  floorElevationM: number | null;
  openings: ObservedOpening[];
  unseen: string[];
  errors: string[];
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
}

function casesRoot(): string {
  return path.resolve('evals/cases');
}

export function listCaseDirs(root = casesRoot()): string[] {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('_') && fs.existsSync(path.join(root, entry.name, 'brief.json')))
    .map(entry => path.join(root, entry.name))
    .sort();
}

function blank(caseId: string, live: boolean, prompt: string, provider: string, model: string): BriefScore {
  return {
    caseId, passed: false, live, prompt, provider, model, overridden: [], diagnostics: [],
    widthM: null, depthM: null, heightM: null, floorElevationM: null, openings: [], unseen: [], errors: [],
  };
}

function near(actual: number, expected: number, tolerance: number): boolean {
  return Math.abs(actual - expected) <= tolerance + 1e-9;
}

export function scoreBrief(caseId: string, briefInput: unknown, expectedInput: unknown, locked: LockedDimension[], meta: { live: boolean; prompt: string; provider: string; model: string }): BriefScore {
  const score = blank(caseId, meta.live, meta.prompt, meta.provider, meta.model);
  let expected: z.infer<typeof expectedSchema>;
  try {
    expected = expectedSchema.parse(expectedInput);
  } catch (error) {
    score.errors.push(error instanceof Error ? error.message : 'Invalid expected file.');
    return score;
  }
  let brief;
  try {
    brief = parseRoomBrief(briefInput);
  } catch (error) {
    score.errors.push(error instanceof Error ? error.message : 'Invalid room brief.');
    score.passed = false;
    return score;
  }
  score.unseen = brief.unseen;
  const reconciled = reconcileBrief(brief, locked);
  score.overridden = reconciled.overridden;
  for (const phrase of expected.unseenIncludes ?? []) {
    if (!brief.unseen.some(item => item.toLowerCase().includes(phrase.toLowerCase()))) {
      score.errors.push(`Unseen notes should mention “${phrase}”.`);
    }
  }
  const expectedOverrides = [...expected.overridden].sort();
  const actualOverrides = [...reconciled.overridden].sort();
  if (actualOverrides.join() !== expectedOverrides.join()) {
    score.errors.push(`Overrides were ${actualOverrides.join(', ') || 'none'}; expected ${expectedOverrides.join(', ') || 'none'}.`);
  }
  let accepted = false;
  try {
    const store = new MemoryStore(emptyRoomProject());
    const state = store.transact(roomTransaction(reconciled.brief));
    const project = state.project;
    accepted = true;
    const id = roomSlug(reconciled.brief.name);
    const lengthOf = (wallId: string) => {
      const wall = project.walls.find(item => item.id === wallId);
      const start = wall && project.nodes.find(node => node.id === wall.start);
      const end = wall && project.nodes.find(node => node.id === wall.end);
      return start && end ? Math.hypot(end.x - start.x, end.z - start.z) : undefined;
    };
    score.widthM = lengthOf(`${id}-south`) ?? null;
    score.depthM = lengthOf(`${id}-east`) ?? null;
    score.heightM = project.walls.find(wall => wall.id === `${id}-south`)?.height ?? null;
    score.floorElevationM = project.slabs.find(slab => slab.id === `${id}-floor`)?.elevation ?? null;
    score.openings = project.openings.flatMap(opening => {
      const wall = sideOfWall(opening.wallId);
      return wall ? [{ wall, kind: opening.kind, widthM: opening.width, offsetM: opening.offset, sillM: opening.sill, heightM: opening.height }] : [];
    });
    score.diagnostics = buildGeometry(project).diagnostics.map(item => ({ code: item.code, message: item.message }));
    const undone = store.undo(project.revision);
    if (undone.project.walls.length !== 0) score.errors.push('Undo left drafted walls in the project.');
  } catch (error) {
    if (error instanceof CoreError) {
      score.diagnostics = (error.diagnostics.length ? error.diagnostics : [{ code: error.code, message: error.message }])
        .map(item => ({ code: item.code, message: item.message }));
    } else throw error;
  }
  if (expected.mustReject) {
    const code = expected.diagnosticCode;
    if (accepted || !code || !score.diagnostics.some(item => item.code === code)) {
      score.errors.push(`Expected the edit to be refused with ${code ?? 'a diagnostic'}.`);
    }
  } else if (!accepted) {
    score.errors.push(...score.diagnostics.map(item => `${item.code}: ${item.message}`));
  } else {
    const codes = score.diagnostics.map(item => item.code).sort();
    const wanted = [...expected.geometryCodes].sort();
    if (codes.join() !== wanted.join()) score.errors.push(`Geometry codes were ${codes.join(', ') || 'none'}; expected ${wanted.join(', ') || 'none'}.`);
    const tolerance = expected.toleranceM;
    const check = (label: string, actual: number | null, wantedValue: number) => {
      if (actual === null || !near(actual, wantedValue, tolerance)) score.errors.push(`${label} is ${actual ?? 'missing'} m; expected ${wantedValue} m ± ${tolerance}.`);
    };
    check('width', score.widthM, expected.widthM);
    check('depth', score.depthM, expected.depthM);
    check('height', score.heightM, expected.heightM);
    check('floor', score.floorElevationM, expected.floorElevationM);
    const used = new Set<number>();
    for (const want of expected.openings) {
      const index = score.openings.findIndex((got, item) => !used.has(item) && got.wall === want.wall && got.kind === want.kind && near(got.widthM, want.widthM, tolerance));
      if (index === -1) score.errors.push(`Missing ${want.kind} on ${want.wall}, width ${want.widthM} m.`);
      else used.add(index);
    }
    score.openings.forEach((got, index) => {
      if (!used.has(index)) score.errors.push(`Extra ${got.kind} on ${got.wall}, width ${got.widthM} m.`);
    });
  }
  score.passed = score.errors.length === 0;
  return score;
}

function missingEvidence(dir: string, evidence: { file: string }[]): string[] {
  return evidence.filter(item => !fs.existsSync(path.join(dir, item.file))).map(item => `Missing evidence file ${item.file}.`);
}

export function scoreCaseDir(dir: string, meta = { live: false, prompt: 'room-brief-v1', provider: 'fixture', model: 'fixture' }): BriefScore {
  const caseFile = caseSchema.parse(readJson(path.join(dir, 'case.json')));
  const score = scoreBrief(caseFile.id, readJson(path.join(dir, 'brief.json')), readJson(path.join(dir, 'expected.json')), caseFile.locked, meta);
  if (caseFile.metric === false && score.unseen.length === 0) score.errors.push('A non-metric reference must list what it could not measure in unseen.');
  score.errors.push(...missingEvidence(dir, caseFile.evidence));
  score.passed = score.errors.length === 0;
  return score;
}

export function scoreRunDir(dir: string): BriefScore {
  const run = runSchema.parse(readJson(path.join(dir, 'run.json')));
  const caseDir = path.join(casesRoot(), run.caseId);
  const caseFile = caseSchema.parse(readJson(path.join(caseDir, 'case.json')));
  const score = scoreBrief(caseFile.id, readJson(path.join(dir, 'brief.json')), readJson(path.join(caseDir, 'expected.json')), caseFile.locked, {
    live: run.live, prompt: run.prompt, provider: run.provider, model: run.model,
  });
  if (caseFile.metric === false && score.unseen.length === 0) score.errors.push('A non-metric reference must list what it could not measure in unseen.');
  score.errors.push(...missingEvidence(caseDir, caseFile.evidence));
  score.passed = score.errors.length === 0;
  return score;
}

export function scorePath(target: string): BriefScore {
  const dir = path.resolve(target);
  return fs.existsSync(path.join(dir, 'run.json')) ? scoreRunDir(dir) : scoreCaseDir(dir);
}
