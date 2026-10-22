/** Metres, right-handed X/Z plan and +Y up. Roof/slab thickness is vertical.
 * Schema is an initial P0 contract, not a stable public format yet. */
export interface Point2 { x: number; z: number }
export interface Node2 extends Point2 { id: string }
export interface Storey { id: string; name: string; elevation: number }
export interface Wall { id: string; name: string; start: string; end: string; thickness: number; base: number; height: number; color: string; roofId?: string; storeyId?: string; finish?: 'siding' | 'concrete'; interior?: string }
/** offset = distance from host start to LEFT edge; sill relative to wall base. */
export interface Opening { id: string; wallId: string; kind: 'door' | 'window'; offset: number; width: number; sill: number; height: number }
export interface Slab { id: string; name: string; polygon: Point2[]; holes: Point2[][]; elevation: number; thickness: number; color: string; storeyId?: string; ceiling?: 'planks' }
/** Roof footprint is axis-aligned; slope/ridge runs along X, ridge parallel Z.
 * Gable: two fixed equal-height eaves, pitches derive shared ridge position.
 * Shed: pitchLeft rises from left eave; pitchRight ignored. */
export interface Roof { id: string; name: string; kind: 'gable' | 'shed'; x: number; z: number; width: number; depth: number; eaveHeight: number; pitchLeft: number; pitchRight: number; thickness: number; color: string }
/** Axis-aligned timber. elevation is the top against a flat ceiling; depth hangs below it.
 * With roofId, the top follows that roof's underside and elevation is unused. */
export interface Beam { id: string; name: string; x: number; z: number; length: number; width: number; depth: number; elevation: number; axis: 'x' | 'z'; color: string; storeyId?: string; roofId?: string }
export interface Asset { id: string; name: string; kind: 'sofa' | 'table' | 'chair' | 'plant' | 'bed' | 'cabinet' | 'glb'; width: number; height: number; depth: number; color: string; file?: string; thumbnail?: string; source?: string; author?: string; license?: string; aiAllowed: boolean }
/** y is metres above the anchor slab top. Without slabId, y is an absolute elevation. rotation is degrees, counterclockwise about +Y. */
export interface Instance { id: string; name: string; assetId: string; x: number; y: number; z: number; rotation: number; scale: number; slabId?: string }
export interface Measurement { id: string; entityId: string; property: string; value: number; locked: boolean; origin: 'measured' | 'chosen' | 'inferred' }
export interface Project { schemaVersion: 1; revision: number; name: string; nodes: Node2[]; storeys: Storey[]; walls: Wall[]; openings: Opening[]; slabs: Slab[]; roofs: Roof[]; beams: Beam[]; assets: Asset[]; instances: Instance[]; measurements: Measurement[] }
export type Collection = 'nodes' | 'storeys' | 'walls' | 'openings' | 'slabs' | 'roofs' | 'beams' | 'assets' | 'instances' | 'measurements';
export type Entity = Node2 | Storey | Wall | Opening | Slab | Roof | Beam | Asset | Instance | Measurement;
/** Entity replacement is schema validated, never unrestricted JSON patch. */
export type Command = { type: 'put'; collection: Collection; entity: Entity } | { type: 'remove'; collection: Collection; id: string } | { type: 'rename'; name: string };
export interface Transaction { requestId: string; baseRevision: number; label: string; commands: Command[]; source: 'user' | 'ai'; allowedIds?: string[] }
export interface MeshData { id: string; kind: 'wall' | 'slab' | 'roof' | 'beam'; positions: number[]; indices: number[]; color: string }
export interface Diagnostic { code: string; message: string; entityId?: string }
export interface GeometryResult { revision: number; meshes: MeshData[]; diagnostics: Diagnostic[] }
export interface CatalogItem { id: string; name: string; thumbnail: string; source: string; dimensions?: number[]; author?: string }
export interface AppState { project: Project; canUndo: boolean; canRedo: boolean; location: string }
export interface DesktopAPI {
  state(): Promise<AppState>;
  transact(tx: Transaction): Promise<AppState>;
  undo(revision: number): Promise<AppState>;
  redo(revision: number): Promise<AppState>;
  open(): Promise<AppState | null>;
  saveAs(): Promise<string | null>;
  importAsset(): Promise<Asset | null>;
  catalog(): Promise<CatalogItem[]>;
  downloadAsset(id: string): Promise<Asset>;
  assetURL(file: string): string;
}
declare global { interface Window { home: DesktopAPI } }
