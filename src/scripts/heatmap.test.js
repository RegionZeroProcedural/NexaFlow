import { buildProject } from './microscope/project-index';
import { traceFunction } from './microscope/interpreter';
import { buildCallBoard, boardNodeId } from './microscope/board';
import { heatmapFromTrace, heatmapFromSimulation, boardWatchpoints, watchSamplesFromTrace, paletteLut, DEFAULT_HEATMAP_SETTINGS, finalizeModel, buildActivityModel, activitySampler, activityStats, sortByActivity, changesInWindow, valueKey, valueSampler, DEFAULT_ACTIVITY_SETTINGS } from './heatmap';
import { snapshot } from './microscope/values';
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

describe('activity heatmap', () => {
  // rows: [label, [[t, value], ...]] with values recorded as interpreter snapshots
  const modelOf = (length, rows) => finalizeModel({ length, rows: rows.map(([label, obs]) => ({ id: label, label, group: 'test', changes: obs.map(([t, v]) => ({ t, v: snapshot(v) })) })) });
  const rowOf = (activity, label) => activity.rows.find(r => r.label === label);
  const sample = (activity, settings, label, ts, revealed = null) => { const fn = activitySampler(activity, { ...DEFAULT_ACTIVITY_SETTINGS, ...settings }, revealed).make(rowOf(activity, label)); return ts.map(t => fn(t)); };
  const range = n => Array.from({ length: n }, (_, i) => i);

  test('a constant value never shows activity, however large', () => {
    const activity = buildActivityModel(modelOf(10, [['big', range(10).map(t => [t, 1000000])]]));
    expect(rowOf(activity, 'big').times.length).toBe(0);
    expect(sample(activity, { window: 5 }, 'big', [0, 5, 9])).toEqual([0, 0, 0]);
  });

  test('an increasing counter shows sustained activity independent of magnitude', () => {
    const activity = buildActivityModel(modelOf(10, [['i', range(10).map(t => [t, t])], ['huge', range(10).map(t => [t, 1e6 + t])]]));
    const i = rowOf(activity, 'i');
    expect(Array.from(i.times)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]); // first value is a baseline
    expect(changesInWindow(i, 9, 5)).toBe(5);
    expect(changesInWindow(i, 9, 25)).toBe(9);
    expect(sample(activity, { window: 5 }, 'i', range(10))).toEqual(sample(activity, { window: 5 }, 'huge', range(10)));
    expect(sample(activity, { window: 5 }, 'i', [9])[0]).toBe(1); // busiest window = peak
  });

  test('a rapidly toggling boolean is highly active', () => {
    const activity = buildActivityModel(modelOf(10, [['flag', range(10).map(t => [t, t % 2 === 0])], ['i', range(10).map(t => [t, t])]]));
    expect(rowOf(activity, 'flag').times.length).toBe(9);
    expect(sample(activity, { window: 5, normalize: 'absolute' }, 'flag', [9])[0]).toBe(1);
  });

  test('repeated identical assignments are not changes', () => {
    const activity = buildActivityModel(modelOf(6, [['x', [[0, 'a'], [1, 'a'], [2, 'a'], [3, 'b'], [4, 'b'], [5, 'c']]]]));
    const x = rowOf(activity, 'x');
    expect(Array.from(x.times)).toEqual([3, 5]);
    expect(x.observations).toBe(6);
  });

  test('sparse observations: missing differs from confirmed unchanged', () => {
    const activity = buildActivityModel(modelOf(120, [['s', [[10, 1], [50, 1], [100, 2]]], ['never', []]]));
    const [before, unchanged, changed] = sample(activity, { window: 5 }, 's', [5, 60, 100]);
    expect(before).toBeNull();          // not observed yet
    expect(unchanged).toBe(0);          // observed, no change in window
    expect(changed).toBeGreaterThan(0); // the single real change
    expect(Array.from(rowOf(activity, 's').times)).toEqual([100]);
    expect(sample(activity, { window: 5 }, 'never', [0, 50])).toEqual([null, null]);
  });

  test('smoothing only spreads existing changes forward', () => {
    const activity = buildActivityModel(modelOf(40, [['burst', [[0, 0], [10, 1]]]]));
    const plain = sample(activity, { window: 5 }, 'burst', range(40));
    const smooth = sample(activity, { window: 5, smoothing: true }, 'burst', range(40));
    expect(smooth.slice(0, 10).every(q => q === 0)).toBe(true); // nothing before the change
    expect(plain.filter(q => q > 0).length).toBe(5);
    expect(smooth.filter(q => q > 0).length).toBe(15);           // fades over two more windows
    expect(activityStats(activity, 5).totalChanges).toBe(1);     // still exactly one change
  });

  test('raw primitives and snapshots get distinct, stable keys', () => {
    expect(valueKey(1)).not.toBe(valueKey('1'));
    expect(valueKey(NaN)).toBe(valueKey(NaN));
    expect(valueKey(snapshot([1, 2]))).not.toBe(valueKey(snapshot([1, 2, 3])));
    expect(valueKey(snapshot(true))).toBe(valueKey(snapshot(true)));
  });

  test('statistics and rendering follow playback progressively', () => {
    const activity = buildActivityModel(modelOf(20, [['i', range(20).map(t => [t, t])], ['flag', range(20).map(t => [t, t >= 15])], ['k', [[0, 7]]]]));
    const early = activityStats(activity, 5, 9);
    expect(early.totalChanges).toBe(9);
    expect(early.activeRows).toBe(1);
    expect(early.observedRows).toBe(3);
    expect(early.mostActive.row.label).toBe('i');
    expect(early.peak).toMatchObject({ count: 5, t: 5 });
    const full = activityStats(activity, 5);
    expect(full.totalChanges).toBe(20); // 19 counter changes + 1 flag flip
    expect(full.activeRows).toBe(2);
    // Positions not yet played back render empty; earlier ones stay visible.
    expect(sample(activity, { window: 5 }, 'i', [8, 9, 10, 12], 10)).toEqual([...sample(activity, { window: 5 }, 'i', [8, 9]), null, null]);
    expect(sortByActivity(activity.rows, 9).map(r => r.label)).toEqual(['i', 'flag', 'k']);
  });

  test('the value heatmap sampler is unaffected by activity settings', () => {
    const model = modelOf(5, [['v', [[0, 0], [2, 10], [4, 5]]]]);
    const fn = valueSampler(DEFAULT_HEATMAP_SETTINGS).make(model.rows[0], { z: 1 });
    expect([0, 1, 2, 3, 4].map(fn)).toEqual([0, 0, 1, 1, 0.5]);
  });

  test('real traces: a loop counter is active, a constant is not', () => {
    const project = buildProject([{ path: 'p/a.js', text: 'export function main() { const LIMIT = 1000000; let hits = 0; for (let i = 0; i < 6; i++) { hits = hits + 1; } return hits + LIMIT; }' }]);
    const run = traceFunction(project, project.rootId);
    const activity = buildActivityModel(heatmapFromTrace(run.events, project));
    expect(rowOf(activity, 'i').times.length).toBe(6);    // 0 baseline, then 1..6
    expect(rowOf(activity, 'hits').times.length).toBe(6);
    expect(rowOf(activity, 'LIMIT').times.length).toBe(0);
    expect(rowOf(activity, 'i').id).toBe(`${project.rootId}::i`); // identity includes the function
  });
});
