import { describe, expect, it } from 'vitest';
import { formatAuthoringNumber, formatFeetInches, formatMetres, formatMillimetres, parseLength } from '../src/units';

describe('display units', () => {
  it('formats metres without becoming the stored value', () => {
    const authored = 4;
    expect(formatMetres(authored)).toBe('4 m');
    expect(formatMillimetres(authored)).toBe('4000 mm');
    expect(formatFeetInches(authored)).toBe('13 ft 1 1/2 in');
    expect(formatAuthoringNumber(2.9)).toBe('2.9');
    expect(authored).toBe(4);
  });

  it('reads feet and inches back into metres', () => {
    expect(parseLength('8 ft 6 in')).toBeCloseTo(8 * 0.3048 + 6 * 0.0254);
    expect(parseLength("8'6\"")).toBeCloseTo(8 * 0.3048 + 6 * 0.0254);
    expect(parseLength('13 ft 1 1/2 in')).toBeCloseTo(13 * 0.3048 + 1.5 * 0.0254);
    expect(parseLength('6 in')).toBeCloseTo(0.1524);
    expect(parseLength('2.9')).toBe(2.9);
    expect(parseLength('2.9 m')).toBe(2.9);
    expect(parseLength(formatFeetInches(2.9))).toBeCloseTo(2.9, 2);
    expect(parseLength('-4 ft 9 in')).toBeCloseTo(-(4 * 0.3048 + 9 * 0.0254));
    expect(parseLength(formatFeetInches(-1.45))).toBeCloseTo(-1.45, 2);
    expect(parseLength('about yea')).toBeUndefined();
  });
});
