import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Header from '../components/header';
import ToolbarLeft from '../components/toolbar-left';
import ToolbarTop from '../components/toolbar-top';
import CanvasNode from '../components/canvasComponents/node';
import Connectors, { bezierPath } from '../components/canvasComponents/connector';
import CanvasLabel from '../components/canvasComponents/canvas-label';
import Inspector from '../components/inspector';
import WaterfallInspector from '../components/waterfall-inspector';
import CodeExportDialog from '../components/code-export-dialog';
import Icon from '../components/icon';
import { NODE_TYPES, getNodeHeight, getNodePorts, createNode, isValidGraph, canConnectPorts, makeId, portPosition } from '../data/node-types';
import { exampleGraph } from '../data/example';
import { customExampleGraph } from '../data/custom-example';
import { variablesExampleGraph } from '../data/variables-example';
import { operatorsExampleGraph } from '../data/operators-example';
import { flowFunctionExample } from '../data/flow-function-example';
import { simulateControlFlow, wouldCreateCycle } from '../scripts/simulate-control-flow';
import { importJavaScriptFunction, listJavaScriptFunctions } from '../scripts/javascript-import';
import { layoutSourceFlow, layoutSourceData } from '../scripts/flow-layout';
import { createSourceWorkspace } from '../scripts/source-workspace';
import SourceImportDialog from '../components/source-import-dialog';
import { prepareWaterfallRun } from '../scripts/waterfall';
import { findNearbyPort, orderPortPair } from '../scripts/connection-utils';
import ProjectImportDialog from '../components/project-import-dialog';
import MicroscopePage from '../components/microscope/microscope-page';
import FunctionSearch from '../components/function-search';
import { buildProject, selectProjectFiles } from '../scripts/microscope/project-index';
import { buildCallBoard, boardNodeId } from '../scripts/microscope/board';
import useEdgeReveal from '../scripts/use-edge-reveal';
import { traceFunction } from '../scripts/microscope/interpreter';
import { heatmapFromSimulation, heatmapFromTrace, boardWatchpoints, watchSamplesFromTrace } from '../scripts/heatmap';

const STORAGE_KEY = 'nexa-flow:workspace:v1';
const PROJECT_STORAGE_KEY = 'nexa-flow:project:v1';
const PROJECT_STORAGE_LIMIT = 3.5 * 1024 * 1024;
const MIN_ZOOM = 0.08;
const MAX_ZOOM = 2;
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const snapTo = n => Math.round(n / 24) * 24;
const copyGraph = g => ({ ...g, nodes: g.nodes.map(n => ({ ...n })), edges: g.edges.map(e => ({ ...e })) });
const escapeXml = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
function loadInitialGraph() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (isValidGraph(stored)) return { ...stored, name: typeof stored.name === 'string' ? stored.name : 'Untitled flow' };
  } catch (_) { /* private mode or a corrupt local save */ }
  return copyGraph(exampleGraph);
}
function downloadBlob(contents, filename, mime) {
  const url = URL.createObjectURL(new Blob([contents], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
function exportSvg(graph) {
  if (!graph.nodes.length) return '';
  const minX = Math.min(...graph.nodes.map(n => n.x)) - 38, minY = Math.min(...graph.nodes.map(n => n.y)) - 40;
  const maxX = Math.max(...graph.nodes.map(n => n.x + NODE_TYPES[n.type].width)) + 38;
  const maxY = Math.max(...graph.nodes.map(n => n.y + getNodeHeight(n) + 10)) + 38;
  const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));
  const connections = graph.edges.map(edge => {
    const source = nodeMap.get(edge.source), target = nodeMap.get(edge.target);
    if (!source || !target) return '';
    const a = portPosition(source, edge.sourcePort, 'out'), b = portPosition(target, edge.targetPort, 'in');
    if (!a || !b) return '';
    const kind = getNodePorts(source).outputs.find(p => p.id === edge.sourcePort)?.kind;
    return `<path d="${bezierPath(a, b)}" fill="none" stroke="${kind === 'boolean' ? '#ac90f0' : '#78829f'}" stroke-width="2.5"/>`;
  }).join('');
  const nodes = graph.nodes.map(n => {
    const meta = NODE_TYPES[n.type];
    const h = getNodeHeight(n);
    const shape = ['custom','function'].includes(n.type) ? n.shape : 'rounded';
    const bg = shape === 'diamond' ? `<polygon points="${n.x + meta.width / 2},${n.y} ${n.x + meta.width},${n.y + h / 2} ${n.x + meta.width / 2},${n.y + h} ${n.x},${n.y + h / 2}" fill="#29223a" stroke="${meta.accent}"/>`
      : shape === 'hexagon' ? `<polygon points="${n.x + meta.width * .12},${n.y} ${n.x + meta.width * .88},${n.y} ${n.x + meta.width},${n.y + h / 2} ${n.x + meta.width * .88},${n.y + h} ${n.x + meta.width * .12},${n.y + h} ${n.x},${n.y + h / 2}" fill="#29223a" stroke="${meta.accent}"/>`
      : `<rect x="${n.x}" y="${n.y}" width="${meta.width}" height="${h}" rx="${shape === 'square' ? 2 : shape === 'pill' ? h / 2 : 13}" fill="#1c1c30" stroke="${meta.accent}" stroke-opacity=".7" stroke-width="1.4"/>`;
    return `<g>${bg}<rect x="${n.x + 12}" y="${n.y + 15}" width="5" height="23" rx="2" fill="${meta.accent}"/><text x="${n.x + 26}" y="${n.y + 26}" fill="${meta.accent}" font-family="Arial,sans-serif" font-size="10" letter-spacing="1.2">${escapeXml(meta.label.toUpperCase())}</text><text x="${n.x + 16}" y="${n.y + 59}" fill="#ffffff" font-family="Arial,sans-serif" font-size="14" font-weight="bold">${escapeXml((n.title || meta.label).slice(0, 28))}</text><text x="${n.x + 16}" y="${n.y + 99}" fill="#b2b6cf" font-family="Arial,sans-serif" font-size="11">${escapeXml((n.description || '').slice(0, 34))}</text>${getNodePorts(n).inputs.map(p => `<circle cx="${n.x}" cy="${n.y + p.top}" r="5" fill="${p.kind === 'boolean' ? '#a68dff' : '#62d7bb'}"/>`).join('')}${getNodePorts(n).outputs.map(p => `<circle cx="${n.x + meta.width}" cy="${n.y + p.top}" r="5" fill="${p.kind === 'boolean' ? '#a68dff' : '#62d7bb'}"/>`).join('')}</g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${maxX - minX}" height="${maxY - minY}" viewBox="${minX} ${minY} ${maxX - minX} ${maxY - minY}"><rect x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" fill="#10111e"/>${connections}${nodes}</svg>`;
}

function MiniMap({ nodes, canvasSize, zoom, pan, setPan }) {
  if (!nodes.length) return null;
  const minX = Math.min(...nodes.map(n => n.x)) - 45;
  const minY = Math.min(...nodes.map(n => n.y)) - 45;
  const maxX = Math.max(...nodes.map(n => n.x + NODE_TYPES[n.type].width)) + 45;
  const maxY = Math.max(...nodes.map(n => n.y + getNodeHeight(n))) + 45;
  const width = maxX - minX, height = maxY - minY;
  const factor = Math.min(180 / width, 102 / height);
  const ox = (188 - width * factor) / 2;
  const oy = (112 - height * factor) / 2;
  const view = { x: ((-pan.x / zoom - minX) * factor + ox), y: ((-pan.y / zoom - minY) * factor + oy), w: canvasSize.width / zoom * factor, h: canvasSize.height / zoom * factor };
  function jump(e) {
    const r = e.currentTarget.getBoundingClientRect();
    const worldX = (e.clientX - r.left - ox) / factor + minX;
    const worldY = (e.clientY - r.top - oy) / factor + minY;
    setPan({ x: canvasSize.width / 2 - worldX * zoom, y: canvasSize.height / 2 - worldY * zoom });
  }
  return <div className="mini-map" title="Click to navigate"><div className="mini-map-top"><Icon name="layers" size={12}/> OVERVIEW</div><svg width="188" height="112" viewBox="0 0 188 112" onPointerDown={jump}>{nodes.map(n => <rect key={n.id} x={ox + (n.x - minX) * factor} y={oy + (n.y - minY) * factor} width={NODE_TYPES[n.type].width * factor} height={getNodeHeight(n) * factor} rx="2" fill={NODE_TYPES[n.type].accent} opacity=".65"/>)}<rect x={view.x} y={view.y} width={view.w} height={view.h} rx="2" fill="rgba(167,139,250,.08)" stroke="#b4a0ff" strokeWidth="1.5"/></svg></div>;
}

export default function Editor() {
  const [graph, setGraph] = useState(loadInitialGraph);
  const graphRef = useRef(graph);
  const [history, setHistory] = useState({ past: [], future: [] });
  const historyRef = useRef(history);
  const [selection, setSelection] = useState(null);
  const [mode, setMode] = useState('select');
  const modeRef = useRef(mode);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const spaceRef = useRef(false);
  const [snap, setSnap] = useState(true);
  const snapRef = useRef(snap);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(zoom);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const panRef = useRef(pan);
  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 550 });
  const canvas = useRef(null);
  const [connection, setConnection] = useState(null);
  const pendingConnectionRef = useRef(null);
  const dragRef = useRef(null);
  const [simulation, setSimulation] = useState(null);
  const [visibleSteps, setVisibleSteps] = useState(0);
  const [runId, setRunId] = useState(0);
  const [playing, setPlaying] = useState(false);
  // Waterfall history is independent of the scrubber, graph edits and Reset.
  // Only initiating a new run replaces its captured observations.
  const [waterfallRun, setWaterfallRun] = useState(null);
  const [waterfallRevealed, setWaterfallRevealed] = useState(0);
  const [waterfallCollapsed, setWaterfallCollapsed] = useState(false);
  const [toast, setToast] = useState(null);
  const [lastSaved, setLastSaved] = useState(true);
  const [codeExporterOpen, setCodeExporterOpen] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(() => window.innerWidth < 900);
  const [rightCollapsed, setRightCollapsed] = useState(() => window.innerWidth < 1140);
  const fileInput = useRef(null);
  const sourceInput = useRef(null);
  const [sourceDraft, setSourceDraft] = useState(null);
  const [graphView, setGraphView] = useState('control');
  const [toolsPinned, setToolsPinned] = useState(false);
  const [simPinned, setSimPinned] = useState(false);
  const [originNodes, setOriginNodes] = useState([]);
  const [project, setProject] = useState(null);
  const [projectDialog, setProjectDialog] = useState(false);
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectProgress, setProjectProgress] = useState('');
  const [projectError, setProjectError] = useState('');
  const [microscopeFn, setMicroscopeFn] = useState(null);
  const [argTexts, setArgTexts] = useState({});
  const projectRef = useRef(null);
  projectRef.current = project;
  const topToolbar = useEdgeReveal(toolsPinned);
  const bottomToolbar = useEdgeReveal(simPinned);
  const preview = useMemo(() => simulateControlFlow(graph), [graph]);

  graphRef.current = graph;
  historyRef.current = history;
  modeRef.current = mode;
  spaceRef.current = spaceHeld;
  snapRef.current = snap;
  zoomRef.current = zoom;
  panRef.current = pan;

  const notify = useCallback((text, tone = 'info') => setToast({ text, tone, time: Date.now() }), []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), 3400); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { const timer = setTimeout(() => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(graph)); setLastSaved(true); } catch (_) { setLastSaved(false); } }, 280); setLastSaved(false); return () => clearTimeout(timer); }, [graph]);

  useEffect(() => {
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(PROJECT_STORAGE_KEY)); } catch (_) { stored = null; }
    if (!stored?.files?.length) return undefined;
    const timer = setTimeout(() => { try { setProject(buildProject(stored.files, { name: stored.name })); } catch (_) { /* stale save */ } }, 30);
    return () => clearTimeout(timer);
  }, []);
  const replaceGraph = useCallback((next, track = true, previous = graphRef.current) => {
    if (track) setHistory(h => ({ past: [...h.past, copyGraph(previous)].slice(-80), future: [] }));
    graphRef.current = next;
    setGraph(next);
    setSimulation(null);
    setVisibleSteps(0);
    setPlaying(false);
    setOriginNodes([]);
  }, []);
  const undo = useCallback(() => {
    const h = historyRef.current;
    if (!h.past.length) return;
    const prior = h.past[h.past.length - 1];
    setHistory({ past: h.past.slice(0, -1), future: [copyGraph(graphRef.current), ...h.future].slice(0, 80) });
    graphRef.current = prior; setGraph(prior); setSimulation(null); setVisibleSteps(0); setSelection(null);
  }, []);
  const redo = useCallback(() => {
    const h = historyRef.current;
    if (!h.future.length) return;
    const next = h.future[0];
    setHistory({ past: [...h.past, copyGraph(graphRef.current)].slice(-80), future: h.future.slice(1) });
    graphRef.current = next; setGraph(next); setSimulation(null); setVisibleSteps(0); setSelection(null);
  }, []);
  const toWorld = useCallback((clientX, clientY) => {
    const r = canvas.current?.getBoundingClientRect() || { left: 0, top: 0 };
    return { x: (clientX - r.left - panRef.current.x) / zoomRef.current, y: (clientY - r.top - panRef.current.y) / zoomRef.current };
  }, []);
  const fitView = useCallback(() => {
    const el = canvas.current;
    const all = graphRef.current.nodes;
    const nodes = graphRef.current.program && graphView === 'data'
      ? layoutSourceData(all, graphRef.current.program.dataEdges || [])
      : all.filter(n => !n.id.startsWith('src_expr_'));
    if (!el || !nodes.length) { setPan({ x: 0, y: 0 }); setZoom(1); return; }
    const rect = el.getBoundingClientRect();
    const minX = Math.min(...nodes.map(n => n.x)), minY = Math.min(...nodes.map(n => n.y));
    const maxX = Math.max(...nodes.map(n => n.x + NODE_TYPES[n.type].width));
    const maxY = Math.max(...nodes.map(n => n.y + getNodeHeight(n)));
    const w = maxX - minX, h = maxY - minY;
    const topGutter = graphRef.current.program ? 142 : 105;
    const bottomGutter = 65;
    const contentHeight = Math.max(80, rect.height - topGutter - bottomGutter);
    const scale = clamp(Math.min((rect.width - 100) / Math.max(w, 1), contentHeight / Math.max(h, 1), 1.12), MIN_ZOOM, MAX_ZOOM);
    const nextPan = { x: (rect.width - w * scale) / 2 - minX * scale, y: topGutter + (contentHeight - h * scale) / 2 - minY * scale };
    zoomRef.current = scale; panRef.current = nextPan; setZoom(scale); setPan(nextPan);
  }, [graphView]);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const observer = new ResizeObserver(entries => { const r = entries[0].contentRect; setCanvasSize({ width: r.width, height: r.height }); });
    observer.observe(el);
    const frame = requestAnimationFrame(fitView);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [fitView]);
  const zoomAt = useCallback((nextZoom, x, y) => {
    const z = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM), old = zoomRef.current;
    const p = panRef.current;
    const next = { x: x - (x - p.x) * (z / old), y: y - (y - p.y) * (z / old) };
    zoomRef.current = z; panRef.current = next; setZoom(z); setPan(next);
  }, []);
  const zoomBy = useCallback(factor => { const r = canvas.current?.getBoundingClientRect(); if (r) zoomAt(zoomRef.current * factor, r.width / 2, r.height / 2); }, [zoomAt]);
  useEffect(() => {
    const el = canvas.current; if (!el) return;
    const handler = e => { e.preventDefault(); const r = el.getBoundingClientRect(); const factor = Math.exp(-e.deltaY * 0.0013); zoomAt(zoomRef.current * factor, e.clientX - r.left, e.clientY - r.top); };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [zoomAt]);

  const selectNode = useCallback(id => { if (id) setSelection({ kind: 'node', id }); }, []);
  const jumpToNode = useCallback(id => { if (id) setSelection({ kind: 'node', id }); }, []);
  const updateProgram = useCallback(props => { const old = graphRef.current; if (!old.program) return; replaceGraph({ ...old, program: { ...old.program, ...props } }); }, [replaceGraph]);
  const addNode = useCallback((type, worldPoint) => {
    const el = canvas.current;
    const r = el?.getBoundingClientRect();
    const p = worldPoint || toWorld((r?.left || 0) + (r?.width || 800) / 2, (r?.top || 0) + (r?.height || 600) / 2);
    const offset = (graphRef.current.nodes.length % 4) * 24;
    const n = createNode(type, snapRef.current ? snapTo(p.x - NODE_TYPES[type].width / 2 + offset) : p.x - NODE_TYPES[type].width / 2 + offset, snapRef.current ? snapTo(p.y - 70 + offset) : p.y - 70 + offset);
    replaceGraph({ ...graphRef.current, nodes: [...graphRef.current.nodes, n] });
    selectNode(n.id);
    if (type === 'function' || type === 'custom' || type === 'variable') setRightCollapsed(false);
    notify(`${NODE_TYPES[type].label} added to canvas`, 'success');
  }, [replaceGraph, selectNode, toWorld, notify]);
  const updateNode = useCallback((id, props) => {
    const prev = graphRef.current;
    const nodes = prev.nodes.map(n => n.id === id ? { ...n, ...props } : n);
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    // Drop edges only when a port is actually removed; existing IDs stay stable.
    const edges = prev.edges.filter(e => getNodePorts(nodeMap.get(e.source)).outputs.some(p => p.id === e.sourcePort) && getNodePorts(nodeMap.get(e.target)).inputs.some(p => p.id === e.targetPort && canConnectPorts(getNodePorts(nodeMap.get(e.source)).outputs.find(x => x.id === e.sourcePort), p)));
    replaceGraph({ ...prev, nodes, edges });
  }, [replaceGraph]);
  const duplicateNode = useCallback(id => {
    const prev = graphRef.current, found = prev.nodes.find(n => n.id === id);
    if (!found) return;
    const n = { ...found, id: makeId(), x: found.x + 36, y: found.y + 36, title: `${found.title} copy` };
    replaceGraph({ ...prev, nodes: [...prev.nodes, n] }); selectNode(n.id);
    notify('Node duplicated', 'success');
  }, [replaceGraph, selectNode, notify]);
  const deleteSelection = useCallback(() => {
    if (!selection) return;
    const g = graphRef.current;
    if (selection.kind === 'node') replaceGraph({ ...g, nodes: g.nodes.filter(n => n.id !== selection.id), edges: g.edges.filter(e => e.source !== selection.id && e.target !== selection.id) });
    else replaceGraph({ ...g, edges: g.edges.filter(e => e.id !== selection.id) });
    setSelection(null);
  }, [selection, replaceGraph]);
  const connectPorts = useCallback((source, sourcePort, target, targetPort) => {
    const g = graphRef.current;
    const sourceNode = g.nodes.find(n => n.id === source), targetNode = g.nodes.find(n => n.id === target);
    const outPort = (sourceNode ? getNodePorts(sourceNode).outputs : []).find(p => p.id === sourcePort);
    const inPort = (targetNode ? getNodePorts(targetNode).inputs : []).find(p => p.id === targetPort);
    if (!outPort || !inPort) { notify('This attachment no longer exists.', 'error'); return false; }
    if (source === target) { notify('A node cannot connect to itself.', 'error'); return false; }
    if (!canConnectPorts(outPort, inPort)) { notify('Incompatible ports. Match data types or connect NEXT ↔ EXEC / DONE.', 'error'); return false; }
    if (g.edges.some(e => e.source === source && e.sourcePort === sourcePort && e.target === target && e.targetPort === targetPort)) return true;
    const edgesWithoutTarget = g.edges.filter(e => !(e.target === target && e.targetPort === targetPort));
    if (wouldCreateCycle(edgesWithoutTarget, source, target)) { notify('Loops are not supported in this version.', 'error'); return false; }
    const edge = { id: makeId('edge'), source, sourcePort, target, targetPort };
    replaceGraph({ ...g, edges: [...edgesWithoutTarget, edge] });
    notify('Nodes connected', 'success');
    return true;
  }, [notify, replaceGraph]);

  // A connection is always direction-neutral from the user's perspective:
  // input -> output clicks and output -> input clicks are both normalized to
  // source -> target edges. A short pointer press arms click-connect; a drag
  // ending on a compatible port completes immediately on the same pointerup.
  const clearConnection = useCallback(() => {
    pendingConnectionRef.current = null;
    if (dragRef.current?.kind === 'connection') dragRef.current = null;
    setConnection(null);
  }, []);
  const commitPair = useCallback((first, second) => {
    const pair = orderPortPair(first, second);
    return pair ? connectPorts(pair.source, pair.sourcePort, pair.target, pair.targetPort) : false;
  }, [connectPorts]);
  const handlePortBegin = useCallback((e, nodeId, portId, direction) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const picked = { nodeId, portId, direction };
    const pending = pendingConnectionRef.current;
    if (pending && !dragRef.current) {
      if (pending.nodeId === nodeId && pending.portId === portId && pending.direction === direction) {
        clearConnection(); // clicking the same port again toggles it off
        return;
      }
      if (pending.direction !== direction) {
        if (commitPair(pending, picked)) { clearConnection(); return; }
        // Invalid target: keep first attachment armed so it can be retried.
        return;
      }
      // Clicking another port on the same side moves the start attachment.
    }
    const node = graphRef.current.nodes.find(n => n.id === nodeId);
    const from = node && portPosition(node, portId, direction);
    if (!from) return;
    const portMeta = getNodePorts(node)[direction === 'out' ? 'outputs' : 'inputs'].find(p => p.id === portId);
    const wire = { ...picked, portMeta, kind: 'connection', from, startX: e.clientX, startY: e.clientY, pointerId: e.pointerId, moved: false };
    pendingConnectionRef.current = wire;
    dragRef.current = e.pointerId === undefined ? null : wire;
    setConnection({ from, to: from, target: null });
  }, [commitPair, clearConnection]);
  const handleNodeDragBegin = useCallback((e, node) => {
    if (modeRef.current === 'pan' || spaceRef.current) { dragRef.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, pan: { ...panRef.current } }; return; }
    dragRef.current = { kind: 'node', id: node.id, startX: e.clientX, startY: e.clientY, initialX: node.x, initialY: node.y, original: copyGraph(graphRef.current), moved: false };
  }, []);
  const backgroundPointerDown = useCallback(e => {
    if (e.button !== 0 && e.button !== 1) return;
    if (e.target.closest?.('[data-node-id], .edge-click-target, .mini-map, .canvas-title-overlay, .toolbar-top, .simulator-controls, .app-toast, .empty-canvas-prompt, .canvas-project-bar, .reveal-tab, .exit-simulation-button')) return;
    if (pendingConnectionRef.current) clearConnection();
    if (e.button === 0 && modeRef.current === 'select' && !spaceRef.current) setSelection(null);
    dragRef.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, pan: { ...panRef.current } };
  }, [clearConnection]);

  useEffect(() => {
    const getPortAt = (e, origin) => {
      // Accept release anywhere within the full labeled port hit target, not
      // just the small knob. This is independent of a second mouse click.
      const hit = document.elementFromPoint?.(e.clientX, e.clientY)?.closest?.('[data-port-direction]');
      if (hit && hit.dataset.portNode !== origin.nodeId && hit.dataset.portDirection !== origin.direction) {
        const node = graphRef.current.nodes.find(n => n.id === hit.dataset.portNode);
        const direction = hit.dataset.portDirection;
        const port = node && getNodePorts(node)[direction === 'out' ? 'outputs' : 'inputs'].find(p => p.id === hit.dataset.portId);
        if (port) {
          const compatible = origin.direction === 'out' ? canConnectPorts(origin.portMeta, port) : canConnectPorts(port, origin.portMeta);
          return { nodeId: node.id, portId: port.id, direction, compatible, position: portPosition(node, port.id, direction) };
        }
      }
      return findNearbyPort(
        graphRef.current.nodes, e.clientX, e.clientY,
        canvas.current?.getBoundingClientRect(), panRef.current, zoomRef.current,
        origin.direction, 35, origin
      );
    };
    const move = e => {
      const drag = dragRef.current;
      if (!drag) {
        const pending = pendingConnectionRef.current;
        if (pending) {
          const target = getPortAt(e, pending);
          setConnection({ from: pending.from, to: target?.compatible ? target.position : toWorld(e.clientX, e.clientY), target: target?.compatible ? target : null });
        }
        return;
      }
      if (drag.kind === 'pan') {
        const next = { x: drag.pan.x + e.clientX - drag.startX, y: drag.pan.y + e.clientY - drag.startY };
        panRef.current = next; setPan(next);
      } else if (drag.kind === 'node') {
        const dx = (e.clientX - drag.startX) / zoomRef.current, dy = (e.clientY - drag.startY) / zoomRef.current;
        if (Math.abs(dx) + Math.abs(dy) < 2 && !drag.moved) return;
        drag.moved = true;
        const x = drag.initialX + dx, y = drag.initialY + dy;
        const g = graphRef.current;
        replaceGraph({ ...g, nodes: g.nodes.map(n => n.id === drag.id ? { ...n, x, y } : n) }, false);
      } else if (drag.kind === 'connection') {
        if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 6) drag.moved = true;
        const target = getPortAt(e, drag);
        setConnection({ from: drag.from, to: target?.compatible ? target.position : toWorld(e.clientX, e.clientY), target: target?.compatible ? target : null });
      }
    };
    const release = e => {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.kind === 'node' && !drag.moved) {
        const clicked = graphRef.current.nodes.find(n => n.id === drag.id);
        if (clicked?.projectFunctionId && projectRef.current?.functions[clicked.projectFunctionId] && !e.target.closest?.('.inline-title, input, button')) setMicroscopeFn(clicked.projectFunctionId);
      }
      if (drag.kind === 'node' && drag.moved) {
        const g = graphRef.current;
        if (snapRef.current) {
          const next = { ...g, nodes: g.nodes.map(n => n.id === drag.id ? { ...n, x: snapTo(n.x), y: snapTo(n.y) } : n) };
          graphRef.current = next; setGraph(next);
        }
        setHistory(h => ({ past: [...h.past, drag.original].slice(-80), future: [] }));
      } else if (drag.kind === 'connection') {
        // Geometry hit-testing works regardless of nested labels, stacking,
        // pointer capture or small port handles. Pointerup *commits* a drop:
        // the user does not need to click the destination again.
        const target = drag.moved ? getPortAt(e, drag) : null;
        if (target) {
          if (target.compatible) {
            if (commitPair(drag, target)) clearConnection();
            else if (drag.moved) clearConnection();
          } else {
            commitPair(drag, target); // visible type mismatch explanation
            if (drag.moved) clearConnection();
          }
        } else if (drag.moved) {
          clearConnection(); // an unsuccessful drag never leaves a ghost wire
        } else {
          // First click, no drag: stay armed until the opposite port is clicked.
          setConnection({ from: drag.from, to: drag.from, target: null });
        }
      }
      dragRef.current = null;
    };
    const cancelled = e => {
      if (dragRef.current?.kind === 'connection' && (e.pointerId == null || e.pointerId === dragRef.current.pointerId)) clearConnection();
      else if (dragRef.current?.kind === 'node' || dragRef.current?.kind === 'pan') dragRef.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', cancelled);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', release); window.removeEventListener('pointercancel', cancelled); };
  }, [replaceGraph, toWorld, commitPair, clearConnection]);

  const launchProjectRun = useCallback((initialSteps, autoplay) => {
    // Call boards run the focused project function in the sandboxed
    // interpreter; board playback steps through each function call.
    const g = graphRef.current, current = projectRef.current;
    const fnId = g.projectBoard.focusId;
    const fn = current.functions[fnId];
    const result = traceFunction(current, fnId, (argTexts[fnId] || []).slice(0, fn.params.length));
    const onBoard = new Set(g.nodes.map(n => n.id));
    const trace = [];
    result.events.forEach((e, i) => {
      if (e.k !== 'enter' || !onBoard.has(boardNodeId(e.fn))) return;
      trace.push({ id: `call-${i}`, nodeId: boardNodeId(e.fn), title: current.functions[e.fn]?.name || e.name, type: 'project-call', detail: `${current.functions[e.fn]?.name || e.name}(${(e.args || []).map(a => a.s).join(', ')})`, eventIndex: i });
    });
    const samples = watchSamplesFromTrace(result.events, boardWatchpoints(g));
    const issues = [result.halted, result.error, ...result.notes].filter(Boolean);
    const simulationResult = { trace, issues, events: [], values: {}, conditions: {}, functionCompletions: [], functionChanges: [], waterfallSamples: samples, projectResult: result };
    const steps = Math.min(trace.length, initialSteps);
    setSimulation(simulationResult);
    setVisibleSteps(steps);
    setWaterfallRevealed(steps);
    setWaterfallRun({ hasRun: true, kind: 'project', name: g.name, samples, total: result.events.length, unit: 'event', heatmap: heatmapFromTrace(result.events, current), stepEvents: trace.map(item => item.eventIndex) });
    setPlaying(autoplay && steps < trace.length);
    setRunId(n => n + 1);
    notify(result.halted ? `Stopped: ${result.halted}` : result.error ? `${fn.name}() finished with ${result.error}` : `${fn.name}() returned ${result.value?.s} · ${result.events.length.toLocaleString()} events, ${trace.length} calls on the board`, result.error || result.halted ? 'error' : 'success');
  }, [argTexts, notify]);
  const launchSimulation = useCallback((initialSteps = 0, autoplay = true) => {
    if (graphRef.current.projectBoard && projectRef.current?.functions[graphRef.current.projectBoard.focusId]) { launchProjectRun(initialSteps, autoplay); return; }
    // The interpreter calculates a bounded trace without executing user code.
    // Playback then reveals one step and its Watch captures at a time.
    const result = prepareWaterfallRun(graphRef.current, simulateControlFlow(graphRef.current));
    const steps = Math.min(result.trace.length, initialSteps);
    setSimulation(result);
    setVisibleSteps(steps);
    setWaterfallRevealed(steps);
    setWaterfallRun({ hasRun: true, kind: 'flow', name: graphRef.current.name, samples: result.waterfallSamples, total: result.trace.length, unit: 'step', heatmap: heatmapFromSimulation(graphRef.current, result) });
    setPlaying(autoplay && steps < result.trace.length);
    setRunId(n => n + 1);
    notify(result.trace.length ? `Simulation started · ${result.trace.length} replay steps` : 'No runnable steps found', result.issues.length ? 'info' : 'success');
  }, [notify, launchProjectRun]);
  const run = useCallback(() => launchSimulation(0, true), [launchSimulation]);
  const step = useCallback(() => {
    if (!simulation || visibleSteps >= simulation.trace.length) launchSimulation(1, false);
    else { setVisibleSteps(s => s + 1); setPlaying(false); }
  }, [simulation, visibleSteps, launchSimulation]);
  // Reset clears the live cursor, not the collected waterfall. The previous run
  // remains inspectable until a fresh Run/Step/Play is started.
  const reset = useCallback(() => { setSimulation(null); setVisibleSteps(0); setPlaying(false); }, []);
  // Leave the replay entirely: no executing/visited highlights or provenance overlays.
  const exitSimulationView = useCallback(() => { reset(); setOriginNodes([]); }, [reset]);
  const seekWaterfall = useCallback(t => {
    const runInfo = waterfallRun;
    if (!runInfo || !simulation) return;
    setPlaying(false);
    if (runInfo.kind === 'project') { let k = 0; while (k < runInfo.stepEvents.length && runInfo.stepEvents[k] <= t) k++; setVisibleSteps(Math.max(1, k)); }
    else setVisibleSteps(Math.min(simulation.trace.length, t + 1));
  }, [waterfallRun, simulation]);
  useEffect(() => { if (simulation) setWaterfallRevealed(previous => Math.max(previous, visibleSteps)); }, [simulation, visibleSteps]);
  useEffect(() => {
    if (!playing || !simulation) return;
    if (visibleSteps >= simulation.trace.length) { setPlaying(false); return; }
    const timer = setTimeout(() => setVisibleSteps(s => s + 1), 280);
    return () => clearTimeout(timer);
  }, [playing, simulation, visibleSteps]);
  const saveFile = useCallback(() => { const g = graphRef.current; downloadBlob(JSON.stringify(g, null, 2), `${(g.name || 'nexa-flow').replace(/[^a-z0-9 _-]/gi, '').replace(/\s+/g, '-').toLowerCase()}.nflow.json`, 'application/json'); notify('Project JSON exported', 'success'); }, [notify]);
  const openFile = useCallback(() => fileInput.current?.click(), []);
  const loadExample = useCallback(() => { replaceGraph(copyGraph(exampleGraph)); setSelection(null); requestAnimationFrame(fitView); notify('Example flow restored', 'success'); }, [replaceGraph, fitView, notify]);
  const loadVariablesExample = useCallback(() => { replaceGraph(copyGraph(variablesExampleGraph)); setSelection(null); requestAnimationFrame(fitView); notify('Functions and variables demo opened', 'success'); }, [replaceGraph, fitView, notify]);
  const loadFlowFunctionExample = useCallback(() => { replaceGraph(copyGraph(flowFunctionExample)); setSelection(null); requestAnimationFrame(fitView); notify('NEXT ↔ EXEC / DONE demo opened', 'success'); }, [replaceGraph, fitView, notify]);
  const loadOperatorExample = useCallback(() => { replaceGraph(copyGraph(operatorsExampleGraph)); setSelection(null); requestAnimationFrame(fitView); notify('EXEC / DONE + Operators demo opened', 'success'); }, [replaceGraph, fitView, notify]);
  const loadCustomExample = useCallback(() => { replaceGraph(copyGraph(customExampleGraph)); setSelection(null); requestAnimationFrame(fitView); notify('Custom logic demo opened', 'success'); }, [replaceGraph, fitView, notify]);
  const newGraph = useCallback(() => {
    if (!window.confirm('Start a new project? The current flow will be replaced. Export it first if you want to keep it.')) return;
    replaceGraph({ name: 'Untitled flow', nodes: [], edges: [] }); setSelection(null); setPan({ x: 0, y: 0 }); setZoom(1); notify('New project created', 'success');
  }, [replaceGraph, notify]);
  const doExportSvg = useCallback(() => {
    if (!graphRef.current.nodes.length) { notify('Add a node before exporting an SVG.', 'error'); return; }
    downloadBlob(exportSvg(graphRef.current), 'nexa-flow-diagram.svg', 'image/svg+xml'); notify('Diagram exported as SVG', 'success');
  }, [notify]);
  const onImport = useCallback(async e => {
    const file = e.target.files?.[0]; e.target.value = ''; if (!file) return;
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('File is too large (5 MB maximum).');
      const data = JSON.parse(await file.text());
      if (!isValidGraph(data)) throw new Error('Invalid flow file. Check node types, ports, and connections.');
      replaceGraph({ ...data, name: typeof data.name === 'string' ? data.name : 'Imported flow' });
      setSelection(null); requestAnimationFrame(fitView); notify('Project imported successfully', 'success');
    } catch (err) { notify(err.message || 'Could not read project file', 'error'); }
  }, [replaceGraph, notify, fitView]);

  const importJavaScript = useCallback(() => sourceInput.current?.click(), []);
  const onJavaScriptImport = useCallback(async e => {
    const files = Array.from(e.target.files || []); e.target.value = '';
    if (!files.length) return;
    try {
      if (files.length > 24) throw new Error('Choose 24 JavaScript files or fewer.');
      const entries = await Promise.all(files.map(async file => {
        if (file.size > 150000) throw new Error(`${file.name}: 150 KB maximum per file.`);
        const path = file.webkitRelativePath || file.name;
        return [path, await file.text()];
      }));
      if (new Set(entries.map(([path]) => path)).size !== entries.length) throw new Error('Duplicate filenames. Use Import JS Folder to preserve their paths.');
      const sources = Object.fromEntries(entries);
      const workspace = createSourceWorkspace(sources);
      const optionsByFile = Object.fromEntries(Object.keys(workspace.files).map(path => [path, listJavaScriptFunctions(workspace.files[path])]));
      if (!Object.values(optionsByFile).some(options => options.length)) throw new Error('No top-level functions found in these source files.');
      const first = Object.keys(optionsByFile).find(path => optionsByFile[path].length) || Object.keys(optionsByFile)[0];
      setSourceDraft({ workspace, optionsByFile, first });
    } catch (err) { notify(err.message || 'Cannot parse selected JavaScript sources', 'error'); }
  }, [notify]);
  const importSelectedFunction = useCallback((path, index) => {
    if (!sourceDraft) return;
    try {
      const imported = importJavaScriptFunction(sourceDraft.workspace.files[path], path, index, sourceDraft.workspace);
      if (!isValidGraph(imported)) throw new Error('Imported graph failed internal validation.');
      replaceGraph(imported); setGraphView('control'); setOriginNodes([]); setSelection(null); setRightCollapsed(false);
      setSourceDraft(null);
      requestAnimationFrame(fitView);
      const dependencies = imported.nodes.filter(n => n.type === 'source-call');
      notify(`Imported ${imported.program.functionName} · ${dependencies.length} compact function calls (${dependencies.filter(n => n.dependencyStatus === 'linked').length} linked)`, 'success');
    } catch (err) { notify(err.message || 'Could not import selected function', 'error'); }
  }, [sourceDraft, replaceGraph, fitView, notify]);
  const importJavaScriptFolder = () => document.getElementById('import-js-folder')?.click();
  const openProjectImport = useCallback(() => { setProjectError(''); setProjectDialog(true); }, []);
  const showOnBoard = useCallback(fnId => {
    const current = projectRef.current;
    if (!current?.functions[fnId]) return;
    replaceGraph(buildCallBoard(current, fnId));
    setGraphView('control'); setMicroscopeFn(null);
    setSelection({ kind: 'node', id: boardNodeId(fnId) });
    requestAnimationFrame(fitView);
  }, [replaceGraph, fitView]);
  const onProjectFolder = useCallback(async e => {
    const picked = Array.from(e.target.files || []); e.target.value = '';
    if (!picked.length) return;
    setProjectBusy(true); setProjectError('');
    try {
      const { kept, skipped } = selectProjectFiles(picked.map(file => ({ path: file.webkitRelativePath || file.name, size: file.size, file })));
      if (!kept.length) throw new Error('No JavaScript/TypeScript source files were found in that folder.');
      const entries = [];
      for (let i = 0; i < kept.length; i++) {
        if (i % 25 === 0) { setProjectProgress(`Reading ${i + 1} of ${kept.length} files…`); await new Promise(r => setTimeout(r, 0)); }
        entries.push({ path: kept[i].path, text: await kept[i].file.text() });
      }
      setProjectProgress(`Parsing and indexing ${entries.length} files…`);
      await new Promise(r => setTimeout(r, 0));
      const name = entries[0].path.split('/')[0] || 'Project';
      const built = buildProject(entries, { name });
      if (!built.rootId) throw new Error('No functions were found in the selected folder.');
      setProject(built);
      try {
        const size = entries.reduce((n, f) => n + f.text.length, 0);
        if (size < PROJECT_STORAGE_LIMIT) localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify({ name, files: entries }));
        else localStorage.removeItem(PROJECT_STORAGE_KEY);
      } catch (_) { /* storage full: project stays in memory for this session */ }
      replaceGraph(buildCallBoard(built, built.rootId));
      setGraphView('control'); setSelection({ kind: 'node', id: boardNodeId(built.rootId) });
      setProjectDialog(false);
      setMicroscopeFn(built.rootId);
      requestAnimationFrame(fitView);
      const root = built.functions[built.rootId];
      notify(`Indexed ${built.stats.functions} functions in ${built.stats.files} files${skipped.length ? ` (${skipped.length} skipped)` : ''}${built.parseErrors.length ? ` · ${built.parseErrors.length} with parse warnings` : ''} · starting at ${root.name}()`, 'success');
    } catch (err) { setProjectError(err.message || 'Could not import that folder'); }
    finally { setProjectBusy(false); setProjectProgress(''); }
  }, [replaceGraph, fitView, notify]);
  const arrangeImportedGraph = useCallback(() => {
    const graph = graphRef.current;
    if (graph.program?.kind !== 'javascript-function') return;
    const next = copyGraph(graph);
    layoutSourceFlow(next.nodes, next.edges);
    replaceGraph(next);
    requestAnimationFrame(fitView);
    notify('Control flow arranged left to right', 'success');
  }, [replaceGraph, fitView, notify]);
  const actions = { saveFile, openFile, importJavaScript, importJavaScriptFolder, importProject: openProjectImport, loadExample, loadCustomExample, loadVariablesExample, loadOperatorExample, loadFlowFunctionExample, newGraph, exportSvg: doExportSvg, exportCode: () => setCodeExporterOpen(true) };
  const doDownloadCode = (code, extension) => { const name = (graphRef.current.name || 'nexa-flow').replace(/[^a-z0-9 _-]/gi, '').replace(/\s+/g, '-').toLowerCase(); downloadBlob(code, `${name}.${extension}`, 'text/plain'); notify('Generated code exported', 'success'); };
  useEffect(() => {
    const keyDown = e => {
      const editing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        if (e.key.toLowerCase() === 's') { e.preventDefault(); saveFile(); return; }
        if (e.key.toLowerCase() === 'o') { e.preventDefault(); openFile(); return; }
        if (e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
        if (e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
        if (e.key.toLowerCase() === 'd' && !editing && selection?.kind === 'node') { e.preventDefault(); duplicateNode(selection.id); return; }
      }
      if (editing) return;
      if (e.code === 'Space') { e.preventDefault(); setSpaceHeld(true); }
      if (e.key === 'v' || e.key === 'V') setMode('select');
      if (e.key === 'h' || e.key === 'H') setMode('pan');
      if (e.key === 'Escape') { setSelection(null); pendingConnectionRef.current = null; dragRef.current = null; setConnection(null); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selection) { e.preventDefault(); deleteSelection(); }
    };
    const keyUp = e => { if (e.code === 'Space') setSpaceHeld(false); };
    const blur = () => setSpaceHeld(false);
    window.addEventListener('keydown', keyDown); window.addEventListener('keyup', keyUp); window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', keyDown); window.removeEventListener('keyup', keyUp); window.removeEventListener('blur', blur); };
  }, [undo, redo, selection, deleteSelection, duplicateNode, saveFile, openFile]);

  const pendingPort = pendingConnectionRef.current;
  const shownSteps = simulation ? simulation.trace.slice(0, visibleSteps) : [];
  const visitedNodes = shownSteps.map(t => t.nodeId);
  const passedEdges = shownSteps.map(t => t.edgeId).filter(Boolean);
  const activeNode = shownSteps[shownSteps.length - 1]?.nodeId;
  const activeEdge = shownSteps[shownSteps.length - 1]?.edgeId;
  const completedNodes = new Set(shownSteps.filter(item => item.type === 'function-completion').map(item => item.nodeId));
  const displayedEdges = graph.program && graphView === 'data' ? [] : graph.edges;
  const displayNodes = useMemo(() => graph.program && graphView === 'data'
    ? layoutSourceData(graph.nodes, graph.program.dataEdges || [])
    : graph.nodes.filter(n => !n.id.startsWith('src_expr_')), [graph.nodes, graph.program, graphView]);
  const displayById = new Map(displayNodes.map(node => [node.id, node]));
  const originSet = new Set(originNodes);
  const conditions = preview.conditions;
  // Timeline position for the waterfall from a playback step count.
  const waterfallAt = shown => {
    if (!waterfallRun?.hasRun) return null;
    if (waterfallRun.kind === 'project') return shown >= waterfallRun.stepEvents.length ? waterfallRun.total : shown > 0 ? waterfallRun.stepEvents[shown - 1] + 1 : 0;
    return shown;
  };
  const waterfallPosition = waterfallAt(simulation ? visibleSteps : waterfallRevealed);
  const waterfallRevealedPosition = waterfallAt(waterfallRevealed);
  const boardWatches = useMemo(() => (graph.projectBoard ? boardWatchpoints(graph) : []), [graph]);
  return <div className="nexa-app"><Header projectName={graph.name} setProjectName={name => { const g = { ...graphRef.current, name }; graphRef.current = g; setGraph(g); }} actions={actions} onRun={run} lastSaved={lastSaved}/><div className="app-workspace"><ToolbarLeft nodeCount={graph.nodes.length} edgeCount={graph.edges.length} onAdd={addNode} onDragStart={(e, type) => { e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData('application/x-nexa-flow-node', type); e.dataTransfer.setData('text/plain', type); }} collapsed={leftCollapsed} setCollapsed={collapsed => { setLeftCollapsed(collapsed); requestAnimationFrame(fitView); }}/><main className="canvas-container"><div className={`flow-canvas ${mode === 'pan' || spaceHeld ? 'pan-mode' : ''} ${dragRef.current?.kind === 'connection' ? 'connecting-mode' : ''}`} ref={canvas} style={{ backgroundPosition: `${pan.x}px ${pan.y}px`, backgroundSize: `${24 * zoom}px ${24 * zoom}px` }} onPointerDown={backgroundPointerDown} onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }} onDrop={e => { e.preventDefault(); const type = e.dataTransfer.getData('application/x-nexa-flow-node'); if (NODE_TYPES[type]) addNode(type, toWorld(e.clientX, e.clientY)); }}>
      <div className="flow-stage" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>{graph.program?.dataEdges && graphView === 'data' && <svg className="data-edge-layer" width="4000" height="3000" style={{ overflow: 'visible', pointerEvents: 'none' }} aria-label="Static data dependencies">{graph.program.dataEdges.map((e, i) => { const a = displayById.get(e.source), b = displayById.get(e.target); if (!a || !b) return null; const x1 = a.x + NODE_TYPES[a.type].width / 2, y1 = a.y + getNodeHeight(a) / 2, x2 = b.x + NODE_TYPES[b.type].width / 2, y2 = b.y + getNodeHeight(b) / 2; return <g key={i}><path d={bezierPath({x:x1,y:y1},{x:x2,y:y2})} fill="none" stroke="#40bfc5" strokeWidth="2" strokeDasharray="7 5" opacity=".7"/><text x={(x1+x2)/2} y={(y1+y2)/2-7} fontSize="12" fill="#8ce8e7">{e.variable}</text></g>; })}</svg>}{graph.callLinks?.length > 0 && graphView !== 'data' && <svg className="call-link-layer" width="4000" height="3000" style={{ overflow: 'visible', pointerEvents: 'none' }} aria-label="Function call links">{graph.callLinks.map((link, i) => { const a = displayById.get(link.source), b = displayById.get(link.target); if (!a || !b) return null; const from = portPosition(a, 'done', 'out'), to = portPosition(b, 'execute', 'in'); if (!from || !to) return null; const back = to.x <= from.x; const d = back ? `M${from.x},${from.y} C${from.x + 120},${from.y - 160} ${to.x - 120},${to.y - 160} ${to.x},${to.y}` : bezierPath(from, to); return <g key={i} className="call-link"><path d={d}/>{link.count > 1 && <text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2 - 8}>×{link.count}</text>}</g>; })}</svg>}<Connectors nodes={displayNodes} edges={displayedEdges} selection={selection} onSelect={setSelection} passedEdges={passedEdges} activeEdge={activeEdge} preview={connection}/>{displayNodes.map(n => <CanvasNode key={n.id} node={n} selected={selection?.kind === 'node' && selection.id === n.id} visited={visitedNodes.includes(n.id) || originSet.has(n.id)} active={activeNode === n.id && Boolean(simulation)} value={preview.values[n.id] ?? null} condition={conditions[n.id] ?? null} onSelect={selectNode} onDragBegin={graphView === 'data' ? (e, id) => { e.preventDefault(); e.stopPropagation(); selectNode(id); } : handleNodeDragBegin} onPortBegin={graphView === 'data' ? (e) => {e.preventDefault(); e.stopPropagation();} : handlePortBegin} connectionAnchor={pendingPort} hoverTarget={connection?.target} functionDone={completedNodes.has(n.id)} onToggle={id => { const node = graphRef.current.nodes.find(item => item.id === id); if (node) updateNode(id, { value: !node.value }); }} onDoubleClick={id => { selectNode(id); setRightCollapsed(false); }} onRename={(id, title) => updateNode(id, { title })} onMicroscope={project ? setMicroscopeFn : null}/>)}</div>
      {connection && <div className="connection-hint" role="status">CONNECT · Drag onto a matching socket, or click either end first · Esc cancels</div>}
      <CanvasLabel name={graph.name} onFit={fitView} onRename={name => { const next = { ...graphRef.current, name }; graphRef.current = next; setGraph(next); }}/><div className={`top-reveal ${topToolbar.open ? 'is-open' : ''} ${toolsPinned ? 'is-pinned' : ''}`}><button ref={topToolbar.tabRef} type="button" className="reveal-tab top-tab" aria-expanded={topToolbar.open} aria-label="Canvas tools — hover to reveal, click to pin" onPointerEnter={topToolbar.reveal} onFocus={topToolbar.reveal} onClick={() => setToolsPinned(v => !v)}>⌄ Canvas tools{toolsPinned ? ' · pinned' : ''}</button><ToolbarTop toolbarRef={topToolbar.toolbarRef} mode={mode} setMode={setMode} undo={undo} redo={redo} canUndo={history.past.length > 0} canRedo={history.future.length > 0} fitView={fitView} zoomIn={() => zoomBy(1.18)} zoomOut={() => zoomBy(1 / 1.18)} zoom={zoom} snap={snap} setSnap={setSnap} onArrange={graph.program ? arrangeImportedGraph : null}/></div>
      {simulation && <button type="button" className="exit-simulation-button" onClick={exitSimulationView} title="Clear the replay highlights and return to the normal editing view">✕ Exit simulation view</button>}
      <div className="canvas-project-bar">{project ? <><FunctionSearch project={project} onOpen={setMicroscopeFn} onShowOnBoard={showOnBoard}/><button type="button" className="canvas-project-button" title="Open the entry function under the microscope" onClick={() => setMicroscopeFn(project.rootId)}>🔬 {project.functions[project.rootId]?.name}()</button></> : <button type="button" className="canvas-project-button" onClick={openProjectImport}>🔬 Import a project folder to dissect its functions</button>}</div>
      {graph.nodes.length === 0 && <div className="empty-canvas-prompt"><div className="empty-canvas-orb"><Icon name="branch" size={35}/></div><h2>Your canvas is ready</h2><p>Add nodes from the library to start building your flow.</p><button type="button" className="primary-button" onClick={() => addNode('start')}><Icon name="plus" size={16}/> Add a start node</button></div>}
      {graph.program && <div className="graph-view-switch"><button type="button" className={graphView === 'control' ? 'active' : ''} onClick={() => setGraphView('control')}>Control flow</button><button type="button" className={graphView === 'data' ? 'active' : ''} onClick={() => setGraphView('data')}>Data dependencies</button><span>{graphView === 'data' ? 'Expanded operators / values · read-only · edit parent statement in Properties' : 'Execution branches'}</span></div>}<div className={`bottom-reveal ${bottomToolbar.open ? 'is-open' : ''} ${simPinned ? 'is-pinned' : ''}`}><button ref={bottomToolbar.tabRef} type="button" className="reveal-tab bottom-tab" aria-expanded={bottomToolbar.open} aria-label="Simulator controls — hover to reveal, click to pin" onPointerEnter={bottomToolbar.reveal} onFocus={bottomToolbar.reveal} onClick={() => setSimPinned(v => !v)}>⌃ Simulator {playing ? '• running' : ''}{simPinned ? ' · pinned' : ''}</button><div className="canvas-bottom-left" ref={bottomToolbar.toolbarRef}><div className="simulator-controls"><span className="sim-indicator"/><span className="simulator-controls-label">SIMULATOR</span><button type="button" className="small-run-button" onClick={run}><Icon name="play" size={14}/> Run</button><button type="button" onClick={() => { setPlaying(false); setVisibleSteps(v => Math.max(0, v - 1)); }} disabled={!simulation || visibleSteps <= 0} title="Rewind one step"><Icon name="chevronLeft" size={15}/></button><button type="button" onClick={step} title="Execute next step"><Icon name="arrowRight" size={16}/> Step</button><button type="button" onClick={() => { if (!simulation || visibleSteps >= simulation.trace.length) launchSimulation(0, true); else setPlaying(v => !v); }} title={playing ? 'Pause playback' : 'Play execution trace'}><Icon name={playing ? 'pause' : 'play'} size={15}/></button><button type="button" onClick={reset} title="Reset execution"><Icon name="rotate" size={15}/></button>{simulation && <><input aria-label="Execution replay position" title="Scrub simulation timeline" type="range" min={0} max={simulation.trace.length} value={visibleSteps} onChange={e => { setPlaying(false); setVisibleSteps(Number(e.target.value)); }} className="execution-timeline"/><span className="step-meter">{visibleSteps}/{simulation.trace.length}</span></>}</div></div></div>
      <MiniMap nodes={displayNodes} canvasSize={canvasSize} pan={pan} zoom={zoom} setPan={setPan}/><div className="canvas-shortcut-hint"><Icon name="hand" size={13}/> Space + drag to pan <span>·</span> Scroll to zoom</div>
      {toast && <div className={`app-toast toast-${toast.tone}`} role="status"><Icon name={toast.tone === 'error' ? 'alert' : toast.tone === 'success' ? 'check' : 'info'} size={16}/>{toast.text}<button type="button" aria-label="Dismiss" onClick={() => setToast(null)}><Icon name="close" size={14}/></button></div>}
    </div></main><Inspector selection={selection} graph={graph} updateNode={updateNode} removeSelection={deleteSelection} duplicateNode={duplicateNode} preview={preview} simulation={simulation} visibleSteps={visibleSteps} onClearSelection={() => setSelection(null)} collapsed={rightCollapsed} setCollapsed={setRightCollapsed} runId={runId} updateProgram={updateProgram} jumpToNode={jumpToNode} highlightOrigin={originNodes} onHighlight={setOriginNodes}/></div><WaterfallInspector run={waterfallRun} cursor={waterfallPosition} revealed={waterfallRevealedPosition} isPlaying={playing} collapsed={waterfallCollapsed} setCollapsed={setWaterfallCollapsed} onJump={jumpToNode} onSeek={simulation ? seekWaterfall : null}/>{projectDialog && <ProjectImportDialog close={() => setProjectDialog(false)} busy={projectBusy} progress={projectProgress} error={projectError} onChooseFolder={() => document.getElementById('import-project-folder')?.click()}/>}<input id="import-project-folder" type="file" multiple webkitdirectory="" directory="" onChange={onProjectFolder} hidden/>{project && microscopeFn && project.functions[microscopeFn] && <MicroscopePage project={project} initialFnId={microscopeFn} onClose={() => setMicroscopeFn(null)} onShowOnBoard={showOnBoard} notify={notify} argTexts={argTexts} setArgTexts={setArgTexts} watchpoints={boardWatches}/>}{sourceDraft && <SourceImportDialog draft={sourceDraft} close={() => setSourceDraft(null)} onImport={importSelectedFunction}/>}<input ref={sourceInput} type="file" multiple accept=".js,.mjs,text/javascript,application/javascript" onChange={onJavaScriptImport} hidden/><input id="import-js-folder" type="file" multiple webkitdirectory="" directory="" onChange={onJavaScriptImport} hidden/><input ref={fileInput} type="file" accept=".json,.nflow.json,application/json" onChange={onImport} hidden/>{codeExporterOpen && <CodeExportDialog graph={graph} close={() => setCodeExporterOpen(false)} download={doDownloadCode}/>}</div>;
}
