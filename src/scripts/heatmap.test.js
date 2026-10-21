import { buildProject } from './microscope/project-index';
import { traceFunction } from './microscope/interpreter';
import { buildCallBoard, boardNodeId } from './microscope/board';
import { heatmapFromTrace, heatmapFromSimulation, boardWatchpoints, watchSamplesFromTrace, paletteLut, DEFAULT_HEATMAP_SETTINGS } from './heatmap';
import { simulateControlFlow } from './simulate-control-flow';
import { prepareWaterfallRun } from './waterfall';
import { variablesExampleGraph } from '../data/variables-example';
import { createNode, isValidGraph } from '../data/node-types';

const files = [{ path: 'p/main.js', text: `
export function main() { let total = 0; const seen = []; for (let i = 1; i <= 4; i++) { total += square(i); seen.push(i); } return total; }
function square(n) { const result = n * n; return result; }
` }];

test('heatmap rows follow every variable over the trace', () => {
  const project = buildProject(files);
  const run = traceFunction(project, project.rootId);
  expect(run.value.s).toBe('30');
  const model = heatmapFromTrace(run.events, project);
  const total = model.rows.find(r => r.label === 'total' && r.group === 'main');
  expect(total.changes.map(c => c.x)).toEqual([0, 1, 5, 14, 30]);
  expect(total.min).toBe(0); expect(total.max).toBe(30);
  const seen = model.rows.find(r => r.label === 'seen');
  expect(seen.numeric).toBe(false); // arrays are ranked by distinct value
  expect(seen.distinct).toBe(5);
  expect(model.rows.some(r => r.group === 'square' && r.label === '⮐ return')).toBe(true);
  expect(model.length).toBe(run.events.length);
});

test('watch nodes wired to board functions capture returns and parameters', () => {
  const project = buildProject(files);
  const board = buildCallBoard(project, project.rootId);
  const squareId = Object.values(project.functions).find(f => f.name === 'square').id;
  const retWatch = { ...createNode('watch', 0, 0), id: 'w1', title: 'square out', check: 'range', min: 0, max: 10 };
  const argWatch = { ...createNode('watch', 0, 0), id: 'w2', title: 'n in' };
  board.nodes.push(retWatch, argWatch);
  board.edges.push({ id: 'e1', source: boardNodeId(squareId), sourcePort: 'out1', target: 'w1', targetPort: 'in' });
  board.edges.push({ id: 'e2', source: 'w2', sourcePort: 'out', target: boardNodeId(squareId), targetPort: 'in1' });
  expect(isValidGraph(board)).toBe(true);
  const points = boardWatchpoints(board);
  expect(points.map(p => p.mode).sort()).toEqual(['param', 'return']);
  const run = traceFunction(project, project.rootId);
  const samples = watchSamplesFromTrace(run.events, points);
  const returns = samples.filter(s => s.watchName === 'square out');
  expect(returns.map(s => s.value)).toEqual([1, 4, 9, 16]);
  expect(returns.filter(s => s.state === 'failed').length).toBe(1); // 16 > max 10
  expect(samples.filter(s => s.watchName === 'n in').map(s => s.value)).toEqual([1, 2, 3, 4]);
});

test('regular flow simulations produce heatmap rows', () => {
  const result = prepareWaterfallRun(variablesExampleGraph, simulateControlFlow(variablesExampleGraph));
  const model = heatmapFromSimulation(variablesExampleGraph, result);
  expect(model.rows.length).toBeGreaterThan(0);
});

test('palette lookup tables have 256 colours', () => {
  expect(paletteLut(DEFAULT_HEATMAP_SETTINGS).length).toBe(768);
  expect(paletteLut({ ...DEFAULT_HEATMAP_SETTINGS, palette: 'custom' }).slice(0, 3)).toEqual(new Uint8ClampedArray([8, 29, 88]));
});

test('watch nodes attach to imported single-function source nodes', () => {
  const { importJavaScriptFunction, exportImportedJavaScript } = require('./javascript-import');
  const { simulateImportedProgram } = require('./forensics');
  const source = 'export function f(a) {\n  let b = a * 2;\n  b = b + 1;\n  return b;\n}\n';
  const graph = importJavaScriptFunction(source, 'f.js', 0);
  const op = graph.nodes.find(n => n.type === 'source-operation' && n.variableName === 'b');
  const watch = { ...createNode('watch', 0, 0), id: 'watch-b', title: 'b watch' };
  const g = { ...graph, nodes: [...graph.nodes, watch], edges: [...graph.edges, { id: 'we', source: op.id, sourcePort: 'value', target: 'watch-b', targetPort: 'in' }], program: { ...graph.program, inputValues: { a: 5 } } };
  expect(isValidGraph(g)).toBe(true);
  const sim = simulateImportedProgram(g);
  expect(sim.watchSamples.filter(s => s.watchId === 'watch-b').map(s => s.value)).toEqual([10]);
  expect(exportImportedJavaScript(g)).toBe(source);
});
