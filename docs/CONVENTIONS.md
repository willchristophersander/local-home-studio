# Coordinates and commands

Metres. Right-handed. X/Z is the plan, +Y is up. Roof and slab thickness are vertical. Feet and inches are display only. Instance `y` is metres above the anchor slab; without `slabId` it is absolute world Y. Rotation is degrees counter-clockwise about +Y.

A transaction is `requestId`, `baseRevision`, `label`, `commands`, and `source` (`user` or `ai`), plus optional `allowedIds`. Commands are `put`, `remove`, and `rename`. The same request id and fingerprint is a no-op. A different payload is `REQUEST_ID_REUSED`. A stale revision is rejected. Undo and redo advance the revision.

Joins under 15° are rejected. P0 roofs are axis-aligned, slope along X, with both eaves fixed when a pitch changes.

Test results and dependency licenses: `../home-design-plan/P0_EVIDENCE.md`.
