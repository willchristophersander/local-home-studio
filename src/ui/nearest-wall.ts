export interface WallSegment { id: string; start: string; end: string }
export interface PlanPoint { id: string; x: number; z: number }

/** The wall nearest the camera. When two are similarly close, the one in front of the view wins. */
export function nearestWallId(walls: WallSegment[], nodes: PlanPoint[], camera: PlanPoint, view: PlanPoint): string | null {
  let best: { id: string; distance: number; facing: number } | null = null;
  const viewLength = Math.hypot(view.x, view.z) || 1;
  const vx = view.x / viewLength;
  const vz = view.z / viewLength;
  for (const wall of walls) {
    const start = nodes.find(node => node.id === wall.start);
    const end = nodes.find(node => node.id === wall.end);
    if (!start || !end) continue;
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const lengthSquared = dx * dx + dz * dz;
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((camera.x - start.x) * dx + (camera.z - start.z) * dz) / lengthSquared));
    const closestX = start.x + dx * t;
    const closestZ = start.z + dz * t;
    const distance = Math.hypot(camera.x - closestX, camera.z - closestZ);
    const midX = (start.x + end.x) / 2 - camera.x;
    const midZ = (start.z + end.z) / 2 - camera.z;
    const midLength = Math.hypot(midX, midZ) || 1;
    const facing = (midX / midLength) * vx + (midZ / midLength) * vz;
    const closer = !best || distance < best.distance - 0.35;
    const sameBand = !!best && Math.abs(distance - best.distance) <= 0.35 && facing > best.facing;
    if (closer || sameBand) best = { id: wall.id, distance, facing };
  }
  return best?.id ?? null;
}
