import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { editorControls, roomBriefJsonSchema } from '../src/ai/room-brief';
import { listCaseDirs, scoreCaseDir, scoreRunDir } from '../src/ai/score';

describe('room brief evals', () => {
  it('keeps the published schema and controls in step with the program', () => {
    const schema = JSON.parse(fs.readFileSync('evals/schema/room-brief.schema.json', 'utf8')) as unknown;
    const controls = JSON.parse(fs.readFileSync('evals/schema/controls.json', 'utf8')) as unknown;
    expect(schema).toEqual(roomBriefJsonSchema());
    expect(controls).toEqual(editorControls);
    const prompt = fs.readFileSync('evals/prompts/room-brief-v1.md', 'utf8');
    expect(prompt).toContain('metres');
    expect(prompt).toContain('unseen');
    expect(prompt).toContain('locked measurement');
    expect(prompt).toContain(`${editorControls.limits.openingClearanceFromJunctionM * 100} cm`);
  });

  it('scores the fixture cases and skips the photo template', () => {
    const dirs = listCaseDirs();
    expect(dirs.map(dir => path.basename(dir))).toEqual([
      'contradictory-width', 'locked-width', 'opening-too-close', 'rectangular-room', 'style-crop', 'two-rooms',
    ]);
    expect(fs.existsSync('evals/cases/_new-room/brief.json')).toBe(true);
    for (const dir of dirs) {
      const score = scoreCaseDir(dir);
      expect(score.live).toBe(false);
      expect(score.errors, score.caseId).toEqual([]);
      expect(score.passed).toBe(true);
    }
  });

  it('scores a recorded run without treating the fixture as a live model', () => {
    const score = scoreRunDir('evals/runs/fixture-rectangular');
    expect(score.passed).toBe(true);
    expect(score.live).toBe(false);
    expect(score.model).toBe('fixture');
    expect(score.widthM).toBeCloseTo(4.2);
    expect(score.openings.map(opening => opening.kind).sort()).toEqual(['door', 'window']);
  });
});
