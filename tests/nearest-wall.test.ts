import { describe, expect, it } from 'vitest';
import { nearestWallId, type PlanPoint, type WallSegment } from '../src/ui/nearest-wall';

const nodes: PlanPoint[] = [
  { id: 'sw', x: 0, z: 0 },
  { id: 'se', x: 8, z: 0 },
  { id: 'ne', x: 8, z: 6 },
  { id: 'nw', x: 0, z: 6 },
];
const walls: WallSegment[] = [
  { id: 'south', start: 'sw', end: 'se' },
  { id: 'east', start: 'se', end: 'ne' },
  { id: 'north', start: 'ne', end: 'nw' },
  { id: 'west', start: 'nw', end: 'sw' },
];

describe('nearest wall', () => {
  it('picks the wall in front of a camera standing outside each side', () => {
    expect(nearestWallId(walls, nodes, { id: 'c', x: 4, z: -8 }, { id: 'v', x: 0, z: 1 })).toBe('south');
    expect(nearestWallId(walls, nodes, { id: 'c', x: 16, z: 3 }, { id: 'v', x: -1, z: 0 })).toBe('east');
    expect(nearestWallId(walls, nodes, { id: 'c', x: 4, z: 14 }, { id: 'v', x: 0, z: -1 })).toBe('north');
    expect(nearestWallId(walls, nodes, { id: 'c', x: -8, z: 3 }, { id: 'v', x: 1, z: 0 })).toBe('west');
  });

  it('prefers the wall the camera is facing when a corner is equally close', () => {
    expect(nearestWallId(walls, nodes, { id: 'c', x: 9, z: -1 }, { id: 'v', x: -5, z: 1 })).toBe('south');
    expect(nearestWallId(walls, nodes, { id: 'c', x: 9, z: -1 }, { id: 'v', x: -1, z: 4 })).toBe('east');
  });
});
