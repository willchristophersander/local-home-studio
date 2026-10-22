import type { Instance, Project } from './shared/model';

export interface WorldPose { x: number; y: number; z: number; rotation: number; scale: number }

/** Anchored furniture keeps a slab-relative offset. Its world elevation is derived. */
export function instanceWorldPose(project: Project, instance: Instance): WorldPose {
  const slab = instance.slabId ? project.slabs.find(item => item.id === instance.slabId) : undefined;
  return {
    x: instance.x,
    y: instance.y + (slab ? slab.elevation : 0),
    z: instance.z,
    rotation: instance.rotation,
    scale: instance.scale,
  };
}
