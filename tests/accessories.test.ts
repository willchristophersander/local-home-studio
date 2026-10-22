import { describe, expect, it } from 'vitest';
import { createSample } from '../src/core/sample';
import { wallAccessories } from '../src/ui/accessories';

describe('wall accessories', () => {
  const sample = createSample();
  const trim = wallAccessories(sample);

  it('faces the siding outward and frames openings', () => {
    const south = trim.filter(box => box.wallId === 'south');
    expect(south.every(box => box.axisZ[2]! < 0)).toBe(true);
    expect(south.filter(box => box.kind === 'corner')).toHaveLength(2);
    expect(south.some(box => box.kind === 'water-table')).toBe(true);
    expect(south.some(box => box.kind === 'fascia')).toBe(false);

    const windowSill = trim.find(box => box.wallId === 'north' && box.kind === 'sill')!;
    expect(windowSill.center[2]).toBeGreaterThan(6.1);
    expect(trim.filter(box => box.wallId === 'south' && box.kind === 'sill')).toHaveLength(0);
    expect(trim.some(box => box.wallId === 'south' && box.kind === 'casing')).toBe(true);
  });

  it('leaves concrete bare and follows a gable with rakes', () => {
    expect(trim.some(box => box.wallId.startsWith('f-') || box.wallId.startsWith('gaf-'))).toBe(false);
    expect(trim.filter(box => box.wallId === 'g-south' && box.kind === 'rake').length).toBeGreaterThan(0);
    expect(trim.some(box => box.wallId === 'u-south' && box.kind === 'fascia')).toBe(true);
  });
});
