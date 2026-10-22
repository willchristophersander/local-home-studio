import React, { useEffect, useMemo, useRef, useState } from 'react';
import { adoptGeometry, beamCeiling, beamFootprint, buildGeometry, roofHeightAt, roofRidgeX } from '../geometry';
import { measurementValue } from '../core/schema';
import { instanceWorldPose } from '../placement';
import type { AppState, Command, GeometryResult, Point2, Project } from '../shared/model';
import { formatAuthoringNumber, formatFeetInches, formatMetres, parseLength } from '../units';
import { beamUnderSlab, openingAt, placeOpening, planLabels } from './edit';
import { createSession, type Session } from './session';
import { mountView, type MarkerSize, type ViewHandle } from './viewport';

function requestId(): string { return crypto.randomUUID(); }

function roofOver(roof: { x: number; z: number; width: number; depth: number }, slabs: { polygon: Point2[] }[]): boolean {
  return slabs.some(slab => {
    const xs = slab.polygon.map(point => point.x);
    const zs = slab.polygon.map(point => point.z);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);
    return minX < roof.x + roof.width && maxX > roof.x && minZ < roof.z + roof.depth && maxZ > roof.z;
  });
}

function paint(ctx: CanvasRenderingContext2D, corners: Point2[], toScreen: (point: Point2) => { x: number; y: number }) {
  const first = toScreen(corners[0]!);
  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  for (const corner of corners.slice(1)) {
    const point = toScreen(corner);
    ctx.lineTo(point.x, point.y);
  }
  ctx.closePath();
}

function wallFrame(start: Point2, end: Point2, thickness: number) {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const length = Math.hypot(dx, dz) || 1;
  return { length, ux: dx / length, uz: dz / length, px: -dz / length * thickness / 2, pz: dx / length * thickness / 2 };
}

function band(start: Point2, frame: ReturnType<typeof wallFrame>, from: number, to: number): Point2[] {
  const at = (distance: number, side: number): Point2 => ({ x: start.x + frame.ux * distance + frame.px * side, z: start.z + frame.uz * distance + frame.pz * side });
  return [at(from, 1), at(to, 1), at(to, -1), at(from, -1)];
}

function MetreField({ label, value, testId, hint, unit = 'length', onCommit }: { label: string; value: number; testId: string; hint?: string; unit?: 'length' | 'angle'; onCommit: (value: number) => Promise<void> }) {
  const shown = unit === 'length' ? formatFeetInches(value) : formatAuthoringNumber(value);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  async function commitValue(raw: string) {
    const next = unit === 'length' ? parseLength(raw) : Number(raw);
    if (next === undefined || !Number.isFinite(next) || Math.abs(next - value) < 1e-9) { setText(shown); return; }
    try { await onCommit(next); }
    catch { setText(shown); }
  }
  const note = unit === 'length' ? (hint ?? formatMetres(value)) : hint;
  return <label className="field"><span>{label}</span><input aria-label={label} data-testid={testId} inputMode="decimal" value={text} onChange={event => setText(event.target.value)} onBlur={event => void commitValue(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void commitValue(event.currentTarget.value); } }} />{note && <small>{note}</small>}</label>;
}

export default function App() {
  const session = useRef<Session | null>(null);
  if (!session.current) session.current = createSession();
  const [state, setState] = useState<AppState | null>(null);
  const [selectedId, setSelectedId] = useState('south');
  const [clip, setClip] = useState<number | null>(null);
  const [lookInside, setLookInside] = useState(false);
  const [levelId, setLevelId] = useState('');
  const [error, setError] = useState('');
  const [marker, setMarker] = useState<MarkerSize | null>(null);
  const [copyPath, setCopyPath] = useState('');
  const planRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<HTMLCanvasElement>(null);
  const view = useRef<ViewHandle | null>(null);
  const mapper = useRef<(x: number, y: number) => Point2>(() => ({ x: 0, z: 0 }));
  const active = session.current;

  useEffect(() => { active.load().then(setState).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))); }, [active]);
  useEffect(() => {
    if (active.mode !== 'desktop') return;
    const onLoad = (event: Event) => {
      const file = (event as CustomEvent<string>).detail;
      if (typeof file !== 'string') return;
      void view.current?.loadMarker(window.home.assetURL(file)).then(setMarker).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
    };
    window.addEventListener('home-load-glb', onLoad);
    return () => window.removeEventListener('home-load-glb', onLoad);
  }, [active]);
  const geometry = useMemo<GeometryResult | null>(() => {
    if (!state) return null;
    return adoptGeometry(state.project.revision, buildGeometry(state.project));
  }, [state]);

  useEffect(() => {
    if (!viewRef.current) return;
    const handle = mountView(viewRef.current);
    view.current = handle;
    return () => { handle.dispose(); view.current = null; };
  }, []);
  useEffect(() => { view.current?.setLookInside(lookInside); }, [lookInside]);
  const display = useMemo(() => {
    if (!state || !geometry) return null;
    if (!levelId) return { project: state.project, geometry };
    const ownSlabs = state.project.slabs.filter(slab => slab.storeyId === levelId);
    const slabIds = new Set(ownSlabs.map(slab => slab.id));
    const walls = state.project.walls.filter(wall => wall.storeyId === levelId);
    const beams = state.project.beams.filter(beam => beam.storeyId === levelId);
    const ceilings = state.project.slabs.filter(slab => beams.some(beam => !beam.roofId && Math.abs(slab.elevation - slab.thickness - beam.elevation) <= 1e-3) && !slabIds.has(slab.id));
    const slabs = [...ownSlabs, ...ceilings];
    const roofs = state.project.roofs.filter(roof => roofOver(roof, ownSlabs));
    const project = { ...state.project, walls, roofs, beams, instances: state.project.instances.filter(item => item.slabId != null && slabIds.has(item.slabId)) };
    const keep = new Set([...walls.map(wall => wall.id), ...slabs.map(slab => slab.id), ...roofs.map(roof => roof.id), ...beams.map(beam => beam.id)]);
    return { project, geometry: { ...geometry, meshes: geometry.meshes.filter(mesh => keep.has(mesh.id)) } };
  }, [state, geometry, levelId]);
  useEffect(() => {
    if (display && view.current) view.current.update(display.project, display.geometry, selectedId, clip);
  }, [display, selectedId, clip]);

  useEffect(() => {
    const canvas = planRef.current;
    if (!canvas || !state || !geometry) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 20) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(rect.width * ratio));
    canvas.height = Math.max(1, Math.floor(rect.height * ratio));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const points = state.project.nodes.map(node => ({ x: node.x, z: node.z }));
    for (const slab of state.project.slabs) points.push(...slab.polygon);
    const minX = Math.min(...points.map(point => point.x)) - 1;
    const maxX = Math.max(...points.map(point => point.x)) + 1;
    const minZ = Math.min(...points.map(point => point.z)) - 1;
    const maxZ = Math.max(...points.map(point => point.z)) + 1;
    const scale = Math.min((rect.width - 36) / (maxX - minX), (rect.height - 36) / (maxZ - minZ));
    const contentWidth = (maxX - minX) * scale;
    const contentHeight = (maxZ - minZ) * scale;
    const offsetX = 18 + Math.max(0, (rect.width - 36 - contentWidth) / 2);
    const offsetY = 18 + Math.max(0, (rect.height - 36 - contentHeight) / 2);
    const toScreen = (point: Point2) => ({ x: offsetX + (point.x - minX) * scale, y: offsetY + (maxZ - point.z) * scale });
    mapper.current = (x, y) => ({ x: minX + (x - offsetX) / scale, z: maxZ - (y - offsetY) / scale });
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.lineJoin = 'round';
    for (const mesh of geometry.meshes) {
      if (mesh.kind !== 'slab') continue;
      const slab = state.project.slabs.find(item => item.id === mesh.id);
      if (levelId && slab?.storeyId !== levelId) continue;
      if (!levelId && (slab?.elevation ?? 0) > 1) continue;
      ctx.beginPath();
      for (let i = 0; i < mesh.indices.length; i += 3) {
        const verts = [0, 1, 2].map(offset => {
          const index = mesh.indices[i + offset]! * 3;
          return { x: mesh.positions[index]!, y: mesh.positions[index + 1]!, z: mesh.positions[index + 2]! };
        });
        const edge1 = { x: verts[1]!.x - verts[0]!.x, z: verts[1]!.z - verts[0]!.z };
        const edge2 = { x: verts[2]!.x - verts[0]!.x, z: verts[2]!.z - verts[0]!.z };
        if (edge1.z * edge2.x - edge1.x * edge2.z <= 0.02) continue;
        const screen = verts.map(vertex => toScreen(vertex));
        ctx.moveTo(screen[0]!.x, screen[0]!.y);
        ctx.lineTo(screen[1]!.x, screen[1]!.y);
        ctx.lineTo(screen[2]!.x, screen[2]!.y);
        ctx.closePath();
      }
      ctx.fillStyle = mesh.id === selectedId ? '#d7ebe4' : mesh.color;
      ctx.globalAlpha = mesh.id === selectedId ? 1 : 0.92;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (!levelId) {
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = '#8a8175';
      for (const slab of state.project.slabs) {
        if (slab.elevation <= 1) continue;
        const corners = slab.polygon.map(toScreen);
        const first = corners[0];
        if (!first) continue;
        ctx.beginPath();
        ctx.moveTo(first.x, first.y);
        for (const corner of corners.slice(1)) ctx.lineTo(corner.x, corner.y);
        ctx.closePath();
        ctx.stroke();
      }
      ctx.restore();
    }
    const planWalls = [...state.project.walls].sort((a, b) => Number(b.finish === 'concrete') - Number(a.finish === 'concrete'));
    for (const item of planWalls) {
      if (levelId && item.storeyId !== levelId) continue;
      const start = state.project.nodes.find(node => node.id === item.start);
      const end = state.project.nodes.find(node => node.id === item.end);
      if (!start || !end) continue;
      const frame = wallFrame(start, end, item.thickness);
      paint(ctx, band(start, frame, 0, frame.length), toScreen);
      ctx.fillStyle = item.id === selectedId ? '#d7ebe4' : item.color;
      ctx.fill();
      ctx.strokeStyle = item.id === selectedId ? '#1f4f48' : '#4e473f';
      ctx.lineWidth = item.id === selectedId ? 2.5 : 1.25;
      ctx.stroke();
      for (const opening of state.project.openings.filter(entry => entry.wallId === item.id)) {
        if (opening.kind === 'door') {
          paint(ctx, band(start, frame, opening.offset, opening.offset + opening.width), toScreen);
          ctx.fillStyle = '#fbfaf6';
          ctx.fill();
        }
        if (opening.id === selectedId) {
          paint(ctx, band(start, frame, opening.offset, opening.offset + opening.width), toScreen);
          ctx.strokeStyle = '#1f4f48';
          ctx.lineWidth = 2.5;
          ctx.stroke();
        }
        if (opening.kind === 'window') {
          const glass = band(start, frame, opening.offset, opening.offset + opening.width).map(toScreen);
          ctx.beginPath();
          ctx.moveTo((glass[0]!.x + glass[3]!.x) / 2, (glass[0]!.y + glass[3]!.y) / 2);
          ctx.lineTo((glass[1]!.x + glass[2]!.x) / 2, (glass[1]!.y + glass[2]!.y) / 2);
          ctx.strokeStyle = '#6e8ea3';
          ctx.lineWidth = 2;
          ctx.stroke();
        } else {
          const hinge = toScreen({ x: start.x + frame.ux * opening.offset, z: start.z + frame.uz * opening.offset });
          const leaf = toScreen({ x: start.x + frame.ux * (opening.offset + opening.width) + frame.px * 2, z: start.z + frame.uz * (opening.offset + opening.width) + frame.pz * 2 });
          ctx.beginPath();
          ctx.moveTo(hinge.x, hinge.y);
          ctx.lineTo(leaf.x, leaf.y);
          ctx.strokeStyle = '#1f4f48';
          ctx.lineWidth = 1.25;
          ctx.stroke();
        }
      }
    }
    for (const beam of state.project.beams) {
      if (levelId) {
        if (beam.storeyId !== levelId) continue;
      } else {
        const storey = state.project.storeys.find(item => item.id === beam.storeyId);
        if ((storey?.elevation ?? 0) > 1) continue;
      }
      paint(ctx, beamFootprint(beam), toScreen);
      ctx.fillStyle = beam.id === selectedId ? '#d7ebe4' : beam.color;
      ctx.fill();
      ctx.strokeStyle = beam.id === selectedId ? '#1f4f48' : '#5c3b24';
      ctx.lineWidth = beam.id === selectedId ? 2 : 1;
      ctx.stroke();
    }
    for (const instance of state.project.instances) {
      const asset = state.project.assets.find(item => item.id === instance.assetId);
      if (!asset) continue;
      if (levelId) {
        const anchor = state.project.slabs.find(item => item.id === instance.slabId);
        if (anchor?.storeyId !== levelId) continue;
      } else {
        const anchor = state.project.slabs.find(item => item.id === instance.slabId);
        if (anchor && anchor.elevation > 1) continue;
      }
      const pose = instanceWorldPose(state.project, instance);
      const radians = pose.rotation * Math.PI / 180;
      const cosine = Math.cos(radians);
      const sine = Math.sin(radians);
      const halfWidth = asset.width * pose.scale / 2;
      const halfDepth = asset.depth * pose.scale / 2;
      const corners = [[-halfWidth, -halfDepth], [halfWidth, -halfDepth], [halfWidth, halfDepth], [-halfWidth, halfDepth]].map(([x, z]) => ({ x: pose.x + x! * cosine - z! * sine, z: pose.z + x! * sine + z! * cosine }));
      paint(ctx, corners, toScreen);
      ctx.fillStyle = instance.id === selectedId ? '#d7ebe4' : asset.color;
      ctx.globalAlpha = 0.9;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = instance.id === selectedId ? '#1f4f48' : '#5c564e';
      ctx.lineWidth = instance.id === selectedId ? 2 : 1;
      ctx.stroke();
    }
    ctx.save();
    ctx.setLineDash([7, 5]);
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = '#6b746b';
    for (const roof of state.project.roofs) {
      if (levelId && !roofOver(roof, state.project.slabs.filter(slab => slab.storeyId === levelId))) continue;
      const corners = [
        { x: roof.x, z: roof.z },
        { x: roof.x + roof.width, z: roof.z },
        { x: roof.x + roof.width, z: roof.z + roof.depth },
        { x: roof.x, z: roof.z + roof.depth },
      ].map(toScreen);
      ctx.beginPath();
      const first = corners[0];
      if (!first) continue;
      ctx.moveTo(first.x, first.y);
      for (const corner of corners.slice(1)) ctx.lineTo(corner.x, corner.y);
      ctx.closePath();
      ctx.stroke();
    }
    ctx.restore();
    ctx.font = '10px "Avenir Next", "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const label of planLabels(state.project, levelId)) {
      const at = toScreen(label);
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#fbfaf6';
      ctx.strokeText(label.text, at.x, at.y);
      ctx.fillStyle = '#1f4f48';
      ctx.fillText(label.text, at.x, at.y);
    }
    ctx.fillStyle = '#6e685f';
    ctx.font = '12px "Avenir Next", "Segoe UI", sans-serif';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('N', offsetX + contentWidth / 2, Math.max(12, offsetY - 6));
  }, [state, geometry, selectedId, levelId]);

  async function commit(label: string, commands: Command[]) {
    if (!state) return;
    setError('');
    try {
      setState(await active.transact({ requestId: requestId(), baseRevision: state.project.revision, label, source: 'user', commands }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    }
  }
  async function run(action: Promise<AppState>) {
    setError('');
    try { setState(await action); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z' || !state) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select')) return;
      event.preventDefault();
      void run(event.shiftKey ? active.redo(state.project.revision) : active.undo(state.project.revision));
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, active]);

  const project = state?.project;
  const selectedWall = project?.walls.find(item => item.id === selectedId);
  const selectedOpening = project?.openings.find(item => item.id === selectedId);
  const selectedSlab = project?.slabs.find(item => item.id === selectedId);
  const selectedRoof = project?.roofs.find(item => item.id === selectedId);
  const selectedBeam = project?.beams.find(item => item.id === selectedId);
  const options = project ? [
    ...project.walls.map(item => ({ id: item.id, label: `Wall · ${item.name}` })),
    ...project.openings.map(item => ({ id: item.id, label: `${item.kind === 'door' ? 'Door' : 'Window'} · ${project.walls.find(wall => wall.id === item.wallId)?.name ?? item.wallId}` })),
    ...project.slabs.map(item => ({ id: item.id, label: `Slab · ${item.name}` })),
    ...project.roofs.map(item => ({ id: item.id, label: `Roof · ${item.name}` })),
    ...project.beams.map(item => ({ id: item.id, label: `Beam · ${item.name}` })),
    ...project.instances.map(item => ({ id: item.id, label: `Object · ${item.name}` })),
  ] : [];

  function selectFromPlan(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!project) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const point = mapper.current(event.clientX - rect.left, event.clientY - rect.top);
    for (const beam of project.beams) {
      const corners = beamFootprint(beam);
      const xs = corners.map(corner => corner.x);
      const zs = corners.map(corner => corner.z);
      if (point.x >= Math.min(...xs) && point.x <= Math.max(...xs) && point.z >= Math.min(...zs) && point.z <= Math.max(...zs)) {
        setSelectedId(beam.id);
        return;
      }
    }
    let best: { id: string; distance: number; along: number; wall?: typeof project.walls[number] } = { id: selectedId, distance: 0.45, along: 0 };
    for (const item of project.walls) {
      const start = project.nodes.find(node => node.id === item.start);
      const end = project.nodes.find(node => node.id === item.end);
      if (!start || !end) continue;
      const length = Math.hypot(end.x - start.x, end.z - start.z);
      const t = Math.max(0, Math.min(1, ((point.x - start.x) * (end.x - start.x) + (point.z - start.z) * (end.z - start.z)) / (length * length)));
      const distance = Math.hypot(point.x - (start.x + (end.x - start.x) * t), point.z - (start.z + (end.z - start.z) * t));
      if (distance < best.distance) best = { id: item.id, distance, along: t * length, wall: item };
    }
    const openingId = best.wall && best.distance < Math.max(best.wall.thickness, 0.3) ? openingAt(project, best.wall, best.along) : undefined;
    setSelectedId(openingId ?? best.id);
  }

  function setLength(itemProject: Project, wallId: string, length: number): Command[] {
    const item = itemProject.walls.find(wall => wall.id === wallId)!;
    const start = itemProject.nodes.find(node => node.id === item.start)!;
    const end = itemProject.nodes.find(node => node.id === item.end)!;
    const current = Math.hypot(end.x - start.x, end.z - start.z);
    const scale = length / current;
    return [{ type: 'put', collection: 'nodes', entity: { ...end, x: start.x + (end.x - start.x) * scale, z: start.z + (end.z - start.z) * scale } }];
  }

  return <div className="shell">
    <div className="banner">
    <header className="top">
      <div><h1>Local Home Studio</h1><p>{project ? project.name : 'Opening project…'}</p></div>
      <div className="spacer" />
      <span data-testid="revision">{project ? `Revision ${project.revision}` : ''}</span>
      <button type="button" data-testid="undo" disabled={!state?.canUndo} onClick={() => state && void run(active.undo(state.project.revision))}>Undo</button>
      <button type="button" data-testid="redo" disabled={!state?.canRedo} onClick={() => state && void run(active.redo(state.project.revision))}>Redo</button>
      <label className="section-control">Level<select data-testid="level-filter" aria-label="Level" value={levelId} onChange={event => setLevelId(event.target.value)}><option value="">All levels</option>{project?.storeys.map(storey => <option key={storey.id} value={storey.id}>{storey.name}</option>)}</select></label>
      <label className="section-control"><input data-testid="section-toggle" type="checkbox" checked={clip != null} onChange={event => setClip(event.target.checked ? 1.5 : null)} />Section</label>
      <label className="section-control"><input data-testid="look-inside" type="checkbox" checked={lookInside} onChange={event => setLookInside(event.target.checked)} />Hide nearest wall</label>
      {clip != null && <><input data-testid="section-clip" type="range" min={0} max={4} step={0.05} value={clip} aria-label="Section height" onChange={event => setClip(Number(event.target.value))} /><span className="section-readout" data-testid="section-readout">{clip.toFixed(2)} m</span></>}
      <button type="button" data-testid="load-marker" onClick={() => void view.current?.loadMarker('/marker-cube.glb').then(setMarker).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))}>Place 1 m marker</button>
      {active.mode === 'desktop' && <>
        <button type="button" data-testid="open-project" onClick={() => void window.home.open().then(next => { if (next) { setState(next); setCopyPath(''); setError(''); } }).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))}>Open</button>
        <button type="button" data-testid="save-copy" onClick={() => void window.home.saveAs().then(saved => { if (saved) setCopyPath(saved); }).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))}>Save a copy</button>
      </>}
    </header>
    {error && <div className="alert" role="alert" data-testid="error">{error}</div>}
    {copyPath && <p className="notice" data-testid="save-status">Saved a copy to {copyPath}</p>}
    </div>
    <main className="workspace">
      <section className="pane plan"><header>Plan</header><canvas ref={planRef} data-testid="plan-canvas" aria-label="Plan, north at the top" onPointerDown={selectFromPlan} /></section>
      <section className="pane view"><header>Model</header><canvas ref={viewRef} data-testid="viewport-canvas" /></section>
      <aside className="pane inspector">
        <h2>Inspector</h2>
        <label className="field"><span>Selection</span>
          <select data-testid="entity-select" value={selectedId} aria-label="Selection" onChange={event => setSelectedId(event.target.value)}>
            {options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </label>
        {project && selectedWall && <>
          <p className="readout" data-testid="wall-length">Centreline {formatFeetInches(measurementValue(project, selectedWall.id, 'length') ?? 0)}. The start point stays fixed.</p>
          <MetreField label="Length" testId="wall-length-input" value={measurementValue(project, selectedWall.id, 'length') ?? 0} onCommit={value => commit('Change wall length', setLength(project, selectedWall.id, value))} />
          <MetreField label="Wall height" testId="wall-height" value={selectedWall.height} onCommit={value => commit('Change wall height', [{ type: 'put', collection: 'walls', entity: { ...selectedWall, height: value } }])} />
          <MetreField label="Wall base" testId="wall-base" value={selectedWall.base} onCommit={value => commit('Change wall base', [{ type: 'put', collection: 'walls', entity: { ...selectedWall, base: value } }])} />
          <MetreField label="Thickness" testId="wall-thickness" value={selectedWall.thickness} onCommit={value => commit('Change wall thickness', [{ type: 'put', collection: 'walls', entity: { ...selectedWall, thickness: value } }])} />
          {selectedWall.finish !== 'concrete' && <label className="field"><span>Interior</span><input data-testid="wall-interior" type="color" aria-label="Interior" value={selectedWall.interior ?? '#f4f1ea'} onChange={event => void commit('Change interior color', [{ type: 'put', collection: 'walls', entity: { ...selectedWall, interior: event.target.value } }])} /></label>}
          <div className="opening-list">
            {project.openings.filter(opening => opening.wallId === selectedWall.id).map(opening => <button type="button" key={opening.id} data-testid={`opening-${opening.id}`} onClick={() => setSelectedId(opening.id)}>{opening.kind === 'door' ? 'Door' : 'Window'} · {formatFeetInches(opening.width)}</button>)}
          </div>
          <div className="actions">
            <button type="button" data-testid="add-door" onClick={() => {
              const opening = placeOpening(project, selectedWall, 'door');
              if (!opening) { setError('This wall has no clear span for another opening.'); return; }
              void commit('Add door', [{ type: 'put', collection: 'openings', entity: opening }]).then(() => setSelectedId(opening.id));
            }}>Add door</button>
            <button type="button" data-testid="add-window" onClick={() => {
              const opening = placeOpening(project, selectedWall, 'window');
              if (!opening) { setError('This wall has no clear span for another opening.'); return; }
              void commit('Add window', [{ type: 'put', collection: 'openings', entity: opening }]).then(() => setSelectedId(opening.id));
            }}>Add window</button>
          </div>
        </>}
        {project && selectedOpening && <>
          <p className="readout">On {project.walls.find(wall => wall.id === selectedOpening.wallId)?.name ?? selectedOpening.wallId}. Offset is measured from the wall start.</p>
          <MetreField label="Offset" testId="opening-offset" value={selectedOpening.offset} onCommit={value => commit('Change opening offset', [{ type: 'put', collection: 'openings', entity: { ...selectedOpening, offset: value } }])} />
          <MetreField label="Width" testId="opening-width" value={selectedOpening.width} onCommit={value => commit('Change opening width', [{ type: 'put', collection: 'openings', entity: { ...selectedOpening, width: value } }])} />
          <MetreField label="Sill" testId="opening-sill" value={selectedOpening.sill} onCommit={value => commit('Change opening sill', [{ type: 'put', collection: 'openings', entity: { ...selectedOpening, sill: value } }])} />
          <MetreField label="Height" testId="opening-height" value={selectedOpening.height} onCommit={value => commit('Change opening height', [{ type: 'put', collection: 'openings', entity: { ...selectedOpening, height: value } }])} />
          <button type="button" data-testid="remove-opening" onClick={() => void commit('Remove opening', [{ type: 'remove', collection: 'openings', id: selectedOpening.id }]).then(() => setSelectedId(selectedOpening.wallId))}>Remove</button>
        </>}
        {project && selectedSlab && <>
          <MetreField label="Top elevation" testId="slab-elevation" value={selectedSlab.elevation} onCommit={value => commit('Change slab elevation', [{ type: 'put', collection: 'slabs', entity: { ...selectedSlab, elevation: value } }])} />
          <div className="actions">
            <button type="button" data-testid="toggle-planks" onClick={() => {
              const next = { ...selectedSlab };
              if (next.ceiling === 'planks') delete next.ceiling;
              else next.ceiling = 'planks';
              void commit(next.ceiling === 'planks' ? 'Add plank ceiling' : 'Clear plank ceiling', [{ type: 'put', collection: 'slabs', entity: next }]);
            }}>{selectedSlab.ceiling === 'planks' ? 'Clear plank ceiling' : 'Plank ceiling'}</button>
            <button type="button" data-testid="add-ceiling-beam" onClick={() => {
              const beam = beamUnderSlab(project, selectedSlab);
              if (!beam) { setError('This slab is too small for a beam.'); return; }
              void commit('Add ceiling beam', [{ type: 'put', collection: 'beams', entity: beam }]).then(() => setSelectedId(beam.id));
            }}>Add a beam</button>
          </div>
          {selectedSlab.holes.length > 0 && <>
            <button type="button" data-testid="add-mezzanine" disabled={project.slabs.some(item => item.id === `mezzanine-${selectedSlab.id}`)} onClick={() => {
              const opening = selectedSlab.holes[0]!;
              const elevation = selectedSlab.elevation + 2.4;
              const storeyId = `storey-mezzanine-${selectedSlab.id}`;
              void commit('Add mezzanine', [
                { type: 'put', collection: 'storeys', entity: { id: storeyId, name: `${selectedSlab.name} mezzanine`, elevation } },
                { type: 'put', collection: 'slabs', entity: { id: `mezzanine-${selectedSlab.id}`, name: `${selectedSlab.name} mezzanine`, polygon: opening.map(point => ({ ...point })), holes: [], elevation, thickness: 0.2, color: '#d7c4a4', storeyId } },
              ]);
            }}>Add mezzanine in opening</button>
            <p className="readout">The mezzanine uses the first opening and sits 2.4 m above this top.</p>
          </>}
          {project.instances.filter(item => item.slabId === selectedSlab.id).map(item => <div className="pose" key={item.id}><span>{item.name}</span><span data-testid={`world-y-${item.id}`}>{instanceWorldPose(project, item).y.toFixed(2)} m</span></div>)}
        </>}
        {project && selectedRoof && <>
          <MetreField label="Eave height" testId="eave-height" value={selectedRoof.eaveHeight} onCommit={value => commit('Change eave', [{ type: 'put', collection: 'roofs', entity: { ...selectedRoof, eaveHeight: value } }])} />
          <MetreField label="Left pitch" testId="pitch-left" unit="angle" hint={`${formatAuthoringNumber(selectedRoof.pitchLeft)}°`} value={selectedRoof.pitchLeft} onCommit={value => commit('Change left pitch', [{ type: 'put', collection: 'roofs', entity: { ...selectedRoof, pitchLeft: value } }])} />
          <MetreField label="Right pitch" testId="pitch-right" unit="angle" hint={`${formatAuthoringNumber(selectedRoof.pitchRight)}°`} value={selectedRoof.pitchRight} onCommit={value => commit('Change right pitch', [{ type: 'put', collection: 'roofs', entity: { ...selectedRoof, pitchRight: value } }])} />
          <p className="readout" data-testid="roof-readout">Eave {selectedRoof.eaveHeight.toFixed(3)} m · Ridge {roofHeightAt(selectedRoof, roofRidgeX(selectedRoof), selectedRoof.z).toFixed(3)} m at x {roofRidgeX(selectedRoof).toFixed(3)} m</p>
        </>}
        {project && selectedBeam && <>
          <p className="readout" data-testid="beam-readout">{selectedBeam.roofId ? 'Hung from the roof underside. ' : ''}Top {beamCeiling(project, selectedBeam).toFixed(3)} m · Bottom {(beamCeiling(project, selectedBeam) - selectedBeam.depth).toFixed(3)} m</p>
          {!selectedBeam.roofId && <MetreField label="Ceiling height" testId="beam-elevation" value={selectedBeam.elevation} onCommit={value => commit('Change beam height', [{ type: 'put', collection: 'beams', entity: { ...selectedBeam, elevation: value } }])} />}
          <MetreField label="Beam depth" testId="beam-depth" value={selectedBeam.depth} onCommit={value => commit('Change beam depth', [{ type: 'put', collection: 'beams', entity: { ...selectedBeam, depth: value } }])} />
          <MetreField label="Beam width" testId="beam-width" value={selectedBeam.width} onCommit={value => commit('Change beam width', [{ type: 'put', collection: 'beams', entity: { ...selectedBeam, width: value } }])} />
        </>}
        {marker && <p className="readout" data-testid="marker-status">Marker {marker.width.toFixed(3)} × {marker.height.toFixed(3)} × {marker.depth.toFixed(3)} m</p>}
        {geometry && geometry.diagnostics.length > 0 && <p className="readout" data-testid="diagnostics">{geometry.diagnostics.map(item => item.message).join(' ')}</p>}
      </aside>
    </main>
    <footer className="footer"><span>{active.mode === 'preview' ? 'In-memory preview' : state?.location}</span><span className="spacer" />Lengths accept feet and inches, such as 8 ft 6 in, and are stored in metres. Joins under 15° are rejected.</footer>
  </div>;
}
