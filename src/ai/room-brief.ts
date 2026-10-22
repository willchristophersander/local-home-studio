import { z } from 'zod';

/** Machine-readable limits the room prompt is allowed to rely on. */
export const editorControls = {
  schemaVersion: 1,
  units: 'metres',
  axes: 'X east, Z north, Y up',
  wallWalk: {
    south: 'west to east',
    east: 'south to north',
    north: 'east to west',
    west: 'north to south',
  },
  openingOffset: 'Metres from the wall start to the first edge of the opening.',
  limits: {
    wallThicknessM: [0.02, 2],
    minSegmentM: 0.02,
    openingClearanceFromJunctionM: 0.01,
    openingClearanceBelowWallTopM: 0.01,
    openingsOnOneWall: 'Horizontal spans must not overlap, including stacked openings.',
    gablePitchDegrees: [1, 80],
    shedPitchDegrees: [0, 80],
  },
  commands: {
    types: ['put', 'remove'],
    collections: ['nodes', 'storeys', 'walls', 'openings', 'slabs', 'roofs', 'beams', 'instances', 'measurements'],
  },
  aiCannot: [
    'rename the project',
    'change asset files or AI-use permissions',
    'write a locked measurement',
    'mark a measurement as measured or chosen',
  ],
} as const;

const side = z.enum(['south', 'east', 'north', 'west']);
const metres = z.number().finite();

export const roomBriefSchema = z.strictObject({
  schemaVersion: z.literal(1),
  name: z.string().trim().min(1).max(80).describe('Short room name.'),
  width: metres.gt(0.3).max(100).describe('Centreline width in metres, west to east.'),
  depth: metres.gt(0.3).max(100).describe('Centreline depth in metres, south to north.'),
  height: metres.gt(0.3).max(30).describe('Wall height in metres, from the floor to the top of the wall.'),
  floorElevation: metres.min(-100).max(100).describe('Floor height in metres. Use 0 when the request does not say otherwise.'),
  wallThickness: metres.min(0.02).max(2).describe('Wall thickness in metres. Use 0.2 unless the photograph shows otherwise.'),
  openings: z.array(z.strictObject({
    wall: side,
    kind: z.enum(['door', 'window']),
    offset: metres.nonnegative().max(100),
    width: metres.positive().max(30),
    sill: metres.nonnegative().max(30),
    height: metres.positive().max(30),
  })).max(40).describe('Doors and windows. Offset follows the wall walk in the controls.'),
  unseen: z.array(z.string().trim().min(1).max(240)).max(40).describe('Walls, dimensions, or adjoining rooms the pictures do not settle.'),
  assumptions: z.array(z.string().trim().min(1).max(240)).max(40).describe('Numbers you chose, including a visual estimate replaced by a locked measurement.'),
});

export type RoomBrief = z.infer<typeof roomBriefSchema>;
export type RoomSide = z.infer<typeof side>;

export function parseRoomBrief(input: unknown): RoomBrief {
  return roomBriefSchema.parse(input);
}

export function roomBriefJsonSchema(): Record<string, unknown> {
  return roomBriefSchema.toJSONSchema() as Record<string, unknown>;
}
