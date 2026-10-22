import { describe, expect, it } from 'vitest';
import { createSample } from '../src/core/sample';
import { buildGeometry } from '../src/geometry';
import { beamUnderSlab, placeOpening, planLabels } from '../src/ui/edit';
import { formatPlanFeet } from '../src/units';

describe('room edits', () => {
  const sample = createSample();

  it('places a door in a free stretch of wall', () => {
    const north = sample.walls.find(wall => wall.id === 'north')!;
    const door = placeOpening(sample, north, 'door');
    expect(door?.kind).toBe('door');
    expect(door?.wallId).toBe('north');
    expect(door && door.offset).toBeGreaterThan(0.1);
    const window = sample.openings.find(opening => opening.id === 'window-n')!;
    expect(door && (door.offset + door.width <= window.offset || door.offset >= window.offset + window.width)).toBe(true);
    const withDoor = { ...sample, openings: [...sample.openings, door!] };
    expect(buildGeometry(withDoor).diagnostics.filter(item => item.entityId === door?.id)).toEqual([]);
  });

  it('hangs a new beam under the studio ceiling', () => {
    const ceiling = sample.slabs.find(slab => slab.id === 'upper-floor')!;
    const beam = beamUnderSlab(sample, ceiling);
    expect(beam?.elevation).toBeCloseTo(2.7);
    expect(beam?.storeyId).toBe('ground');
    expect(beam?.axis).toBe('x');
    expect(beam && beam.length).toBeGreaterThan(7);
    const withBeam = { ...sample, beams: [...sample.beams, beam!] };
    expect(buildGeometry(withBeam).diagnostics.filter(item => item.code.startsWith('BEAM'))).toEqual([]);
  });

  it('labels wall lengths, openings, and beam spacing in feet and inches', () => {
    const labels = planLabels(sample, '').map(label => label.text);
    expect(labels).toContain(formatPlanFeet(8));
    expect(labels).toContain(formatPlanFeet(1));
    expect(labels.filter(text => text === formatPlanFeet(1.5)).length).toBeGreaterThan(0);
  });
});
