/** Formatting rounds for display. The project keeps the metre value from parseLength. */
const FOOT = 0.3048;
const INCH = 0.0254;

function trim(value: number): string {
  return String(Math.round(value * 10000) / 10000);
}

export function formatMetres(metres: number): string {
  return `${trim(metres)} m`;
}

export function formatMillimetres(metres: number): string {
  return `${trim(metres * 1000)} mm`;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** Nearest inch, for short plan labels. Rounding here must not become a stored measurement. */
export function formatPlanFeet(metres: number): string {
  const sign = metres < 0 ? '-' : '';
  let inches = Math.round(Math.abs(metres) / INCH);
  const feet = Math.floor(inches / 12);
  inches -= feet * 12;
  if (feet === 0) return `${sign}${inches} in`;
  if (inches === 0) return `${sign}${feet} ft`;
  return `${sign}${feet} ft ${inches} in`;
}

/** Nearest 1/16 inch. Rounding here must not become a stored measurement. */
export function formatFeetInches(metres: number): string {
  const sign = metres < 0 ? '-' : '';
  let sixteenths = Math.round(Math.abs(metres) / INCH * 16);
  const feet = Math.floor(sixteenths / (12 * 16));
  sixteenths -= feet * 12 * 16;
  const inches = Math.floor(sixteenths / 16);
  const numerator = sixteenths % 16;
  const divisor = gcd(numerator, 16);
  const fraction = numerator === 0 ? '' : ` ${numerator / divisor}/${16 / divisor}`;
  return `${sign}${feet} ft ${inches}${fraction} in`;
}

export function formatAuthoringNumber(value: number): string {
  if (!Number.isFinite(value)) return '';
  return String(Math.round(value * 1e6) / 1e6);
}

/** A bare number is metres. Feet and inches use ft, in, ' or ". */
export function parseLength(raw: string): number | undefined {
  const text = raw.trim().toLowerCase().replace(/[′’]/g, "'").replace(/[″”]/g, '"');
  if (!text) return undefined;
  if (/ft|'|in|"/.test(text)) {
    const feet = text.match(/(-?\d+(?:\.\d+)?)\s*(?:ft|')/);
    const inches = text.match(/(-?\d+(?:\.\d+)?)(?:\s+(\d+)\s*\/\s*(\d+))?\s*(?:in|")/);
    let total = 0;
    let found = false;
    if (feet) { total += Number(feet[1]) * FOOT; found = true; }
    if (inches) {
      let inch = Number(inches[1]);
      if (inches[2] && inches[3]) inch += Number(inches[2]) / Number(inches[3]);
      if (feet && Number(feet[1]) < 0 && inch > 0) inch = -inch;
      total += inch * INCH;
      found = true;
    }
    return found && Number.isFinite(total) ? total : undefined;
  }
  const metres = text.match(/^(-?\d+(?:\.\d+)?)\s*m?$/);
  if (!metres) return undefined;
  const value = Number(metres[1]);
  return Number.isFinite(value) ? value : undefined;
}
