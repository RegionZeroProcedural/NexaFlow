/** Spectrum-analyzer style "waterfall" heatmaps of program state.
 *
 * A model is { length, rows: [{ id, label, group, changes: [{ t, v, flag? }] }] }
 * where t is a position on the execution timeline and v a value snapshot
 * ({ t: type, s: preview, n?: magnitude }). A row holds its last value until
 * the next change, exactly like a register over time. */
import { snapshot } from './microscope/values';
import { checkWatchRule } from './forensics';
import { getNodePorts } from '../data/node-types';

export const PALETTES = {
  spectrum: { name: 'Spectrum (turbo)', stops: ['#30123b', '#4145ab', '#4675ed', '#39a2fc', '#1bcfd4', '#24eca6', '#61fc6c', '#a4fc3b', '#d1e834', '#f3c63a', '#fe9b2d', '#f36315', '#d93806', '#b11901', '#7a0402'] },
  analyzer: { name: 'Classic analyzer', stops: ['#000010', '#00007f', '#0000ff', '#00ffff', '#00ff00', '#ffff00', '#ff7f00', '#ff0000'] },
  inferno: { name: 'Inferno', stops: ['#000004', '#1b0c41', '#4a0c6b', '#781c6d', '#a52c60', '#cf4446', '#ed6925', '#fb9b06', '#f7d13d', '#fcffa4'] },
  viridis: { name: 'Viridis', stops: ['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'] },
  plasma: { name: 'Plasma', stops: ['#0d0887', '#46039f', '#7201a8', '#9c179e', '#bd3786', '#d8576b', '#ed7953', '#fb9f3a', '#fdca26', '#f0f921'] },
  ocean: { name: 'Ocean', stops: ['#03051a', '#0b2a5b', '#145c8f', '#1f8fb5', '#53c2c9', '#b4ecd9', '#f4fff9'] },
  grayscale: { name: 'Grayscale', stops: ['#111111', '#ffffff'] },
  custom: { name: 'Custom…', stops: null },
};
export const DEFAULT_HEATMAP_SETTINGS = { palette: 'spectrum', custom: ['#081d58', '#41b6c4', '#ffffd9'], empty: '#0b0c16', mode: 'value', scale: 'linear' };

const hex = c => { const h = c.replace('#', ''); const f = h.length === 3 ? h.split('').map(x => x + x).join('') : h; return [parseInt(f.slice(0, 2), 16), parseInt(f.slice(2, 4), 16), parseInt(f.slice(4, 6), 16)]; };
/** 256-entry RGB lookup table for a palette. */
export function paletteLut(settings) {
  const stops = (settings.palette === 'custom' ? settings.custom : PALETTES[settings.palette]?.stops || PALETTES.spectrum.stops).map(hex);
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const p = (i / 255) * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(p)), f = p - k;
    const a = stops[k], b = stops[Math.min(stops.length - 1, k + 1)];
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = a[c] + (b[c] - a[c]) * f;
  }
  return lut;
}
export const paletteCss = settings => `linear-gradient(90deg, ${(settings.palette === 'custom' ? settings.custom : PALETTES[settings.palette]?.stops || PALETTES.spectrum.stops).join(', ')})`;
export const rgbOf = hex;

/** Give every change a raw numeric coordinate and every row its range. */
export function finalizeModel(model) {
  for (const row of model.rows) {
    const ranks = new Map();
    // Numbers/booleans are plotted by value; everything else (strings,
    // objects, arrays) by distinct value, so each new state shifts colour.
    let numeric = true;
    for (const change of row.changes) if (change.v && change.v.t !== 'undefined' && !['number', 'boolean', 'bigint'].includes(change.v.t)) numeric = false;
    for (const change of row.changes) {
      if (!change.v || change.v.t === 'undefined') { change.x = null; continue; }
      if (numeric) change.x = change.v.n;
      else {
        // Non-numeric rows: each distinct value gets its own band so changes stand out.
        const key = `${change.v.t}:${change.v.s}`;
        if (!ranks.has(key)) ranks.set(key, ranks.size);
        change.x = ranks.get(key);
      }
    }
    const xs = row.changes.map(c => c.x).filter(x => typeof x === 'number' && Number.isFinite(x));
    row.min = xs.length ? Math.min(...xs) : 0;
    row.max = xs.length ? Math.max(...xs) : 0;
    row.numeric = numeric;
    row.distinct = numeric ? null : ranks.size;
  }
  return model;
}

const fnLabel = (project, fnId) => project?.functions[fnId]?.name || (fnId?.startsWith('module:') ? `module ${fnId.slice(7).split('/').pop()}` : 'anonymous');

/** Every variable written anywhere during a microscope trace. */
export function heatmapFromTrace(events, project) {
  const rows = new Map();
  const add = (key, label, group, fnId, t, v) => {
    let row = rows.get(key);
    if (!row) rows.set(key, row = { id: key, label, group, fnId, changes: [] });
    row.changes.push({ t, v });
  };
  events.forEach((e, t) => {
    if (e.k === 'write' && e.v) add(`${e.fn}::${e.name}`, e.name, fnLabel(project, e.fn), e.fn, t, e.v);
    else if (e.k === 'exit' && e.v && !e.threw) add(`${e.fn}::⮐`, '⮐ return', fnLabel(project, e.fn), e.fn, t, e.v);
  });
  const ordered = [...rows.values()].sort((a, b) => a.changes[0].t - b.changes[0].t);
  // Statement steps: the interpreter timeline has one entry per evaluated
  // expression, so "execution steps" for activity windows count statements.
  const stepOf = new Int32Array(events.length);
  let step = 0;
  events.forEach((e, i) => { if (e.k === 'stmt') step++; stepOf[i] = step; });
  return finalizeModel({ length: events.length, rows: ordered, stepOf });
}

/** Variables of a regular flow simulation (or an imported single function). */
export function heatmapFromSimulation(graph, simulation) {
  const trace = simulation?.trace || [];
  const rows = new Map();
  const add = (key, label, group, t, value) => {
    let row = rows.get(key);
    if (!row) rows.set(key, row = { id: key, label, group, changes: [] });
    row.changes.push({ t, v: snapshot(value) });
  };
  if (simulation?.snapshots?.length) {
    // Forensics runs record the full environment after each step.
    const group = graph.program?.functionName || 'function';
    const previous = new Map();
    simulation.snapshots.forEach((env, t) => {
      for (const [name, value] of Object.entries(env)) {
        let encoded;
        try { encoded = JSON.stringify(value); } catch (_) { encoded = String(value); }
        if (previous.get(name) === encoded) continue;
        previous.set(name, encoded);
        add(name, name === '$return' ? '⮐ return' : name, group, t, value);
      }
    });
  } else {
    const index = new Map(trace.map((item, i) => [item.id, i]));
    for (const revision of simulation?.functionChanges || []) {
      const t = index.has(revision.id) ? index.get(revision.id) : 0;
      add(`${revision.nodeId}::${revision.variable}`, revision.variable, revision.title || 'Function', t, revision.value);
    }
    for (const node of graph.nodes) {
      if (node.type === 'variable') add(node.id, node.title, 'Variables', 0, node.dataValue);
      else if (simulation?.values && Object.prototype.hasOwnProperty.call(simulation.values, node.id) && ['add', 'subtract', 'multiply', 'divide', 'modulo', 'power', 'negate', 'concat', 'compare'].includes(node.type)) {
        const t = trace.findIndex(item => item.nodeId === node.id);
        add(node.id, node.title, 'Operators', Math.max(0, t), simulation.values[node.id]);
      }
    }
  }
  for (const row of rows.values()) row.changes.sort((a, b) => a.t - b.t);
  return finalizeModel({ length: Math.max(1, trace.length), rows: [...rows.values()] });
}

/** Watch-node samples (already produced by the flow simulator) as heatmap rows. */
export function heatmapFromSamples(samples, length) {
  const rows = new Map();
  for (const sample of samples) {
    const key = sample.watchId || sample.nodeId || sample.watchName;
    let row = rows.get(key);
    if (!row) rows.set(key, row = { id: key, label: sample.watchName, group: sample.variable, changes: [] });
    row.changes.push({ t: Math.max(0, (sample.step || 1) - 1), v: sample.snapshot || snapshot(sample.value), flag: sample.state === 'failed' || sample.state === 'unknown', sample });
  }
  return finalizeModel({ length: Math.max(1, length), rows: [...rows.values()] });
}

/** Watch nodes on the call board that point at imported project functions.
 * - Function out1  → Watch : the function's return values
 * - Function DONE  → Watch : every completed call
 * - Watch out → Function inN : values passed to parameter N
 * - Watch set to a named variable: writes of that local inside the function */
export function boardWatchpoints(graph) {
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const points = [];
  for (const edge of graph.edges) {
    const source = byId.get(edge.source), target = byId.get(edge.target);
    if (!source || !target) continue;
    let watch = null, fn = null, mode = null, paramIndex = null;
    if (target.type === 'watch' && source.projectFunctionId) {
      watch = target; fn = source;
      mode = edge.sourcePort === 'done' ? 'done' : 'return';
    } else if (source.type === 'watch' && target.projectFunctionId && /^in\d+$/.test(edge.targetPort)) {
      watch = source; fn = target; mode = 'param'; paramIndex = Number(edge.targetPort.slice(2)) - 1;
    }
    if (!watch) continue;
    if (watch.traceVariable === 'named' && watch.traceVariableName) mode = 'named';
    const portLabel = mode === 'param' ? (getNodePorts(fn).inputs.find(p => p.id === edge.targetPort)?.label || `arg ${paramIndex + 1}`) : null;
    points.push({
      id: `${watch.id}:${edge.id}`, watchId: watch.id, title: watch.title, fnId: fn.projectFunctionId, fnTitle: fn.title, mode, paramIndex,
      name: watch.traceVariableName || null,
      label: mode === 'return' ? `${fn.title}() ⮐` : mode === 'done' ? `${fn.title}() calls` : mode === 'param' ? `${fn.title}(${portLabel})` : `${fn.title} › ${watch.traceVariableName}`,
      rule: { check: watch.check || 'range', min: watch.min ?? 0, max: watch.max ?? 100, expected: watch.expected ?? 'true', expectedType: watch.expectedType || 'number' },
    });
  }
  return points;
}

/** Value of a snapshot for watch-rule checks (numbers/booleans/strings). */
function plainValue(v) {
  if (!v) return null;
  if (v.t === 'number') return v.n ?? Number(v.s);
  if (v.t === 'boolean') return v.s === 'true';
  if (v.t === 'string') { try { return JSON.parse(v.s); } catch (_) { return v.s; } }
  if (v.t === 'null' || v.t === 'undefined') return null;
  return v.s;
}

/** Samples for board watchpoints from a microscope trace. */
export function watchSamplesFromTrace(events, points) {
  const samples = [];
  if (!points.length) return samples;
  const byFn = new Map();
  for (const p of points) { if (!byFn.has(p.fnId)) byFn.set(p.fnId, []); byFn.get(p.fnId).push(p); }
  const push = (p, t, v) => {
    const value = plainValue(v);
    const status = checkWatchRule(p.rule, value, v?.t === 'external');
    samples.push({ id: `${p.id}:${t}`, watchId: p.id, nodeId: p.watchId, watchName: p.title, variable: p.label, step: t + 1, value, snapshot: v, display: v?.s, dataType: v?.t, state: status.failed ? (v?.t === 'external' ? 'unknown' : 'failed') : 'passed', reason: status.reason || 'Validation passed' });
  };
  events.forEach((e, t) => {
    const list = byFn.get(e.fn);
    if (!list) return;
    for (const p of list) {
      if (p.mode === 'return' && e.k === 'exit' && !e.threw) push(p, t, e.v);
      else if (p.mode === 'done' && e.k === 'exit') push(p, t, { t: 'boolean', s: e.threw ? 'false' : 'true', n: e.threw ? 0 : 1 });
      else if (p.mode === 'param' && e.k === 'enter') push(p, t, e.args?.[p.paramIndex] || { t: 'undefined', s: 'undefined' });
      else if (p.mode === 'named' && e.k === 'write' && e.name === p.name) push(p, t, e.v);
    }
  });
  return samples;
}

// ---------------------------------------------------------------------------
// Cell samplers: how the shared canvas renderer colours each row over time.
// A sampler is { key, make(row, view) → (t) => q | null, describe(row, t),
// ticks(row), legend, title(row) }. `make` returns a stateful function that
// is called with non-decreasing t, so samplers can walk rows with pointers.
// q is an intensity in [0, 1]; null means "no observation" (empty colour).
// ---------------------------------------------------------------------------
export const logish = x => Math.sign(x) * Math.log1p(Math.abs(x));
/** Number of sorted entries ≤ t (binary search). */
export function upperBound(sorted, t, key = null) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if ((key ? sorted[mid][key] : sorted[mid]) <= t) lo = mid + 1; else hi = mid; }
  return lo;
}
/** Latest observation of a row at or before t. */
export function valueAt(row, t) {
  const k = upperBound(row.changes, t, 't');
  return k ? row.changes[k - 1] : null;
}

/** Value Heatmap: what each variable contains (or, in its "recent writes"
 * mode, how recently it was written). Driven by the shared colour settings. */
export function valueSampler(settings) {
  const log = settings.scale === 'log';
  return {
    key: `value:${settings.mode}:${settings.scale}`,
    legend: settings.mode === 'activity' ? ['idle', 'just written'] : ['low', 'high'],
    make(row, { z }) {
      const tau = Math.max(2, 10 / z);
      const mn = log ? logish(row.min) : row.min, mx = log ? logish(row.max) : row.max, span = mx - mn;
      const changes = row.changes;
      let j = -1;
      return t => {
        while (j + 1 < changes.length && changes[j + 1].t <= t) j++;
        const c = j >= 0 ? changes[j] : null;
        if (!c) return null;
        if (settings.mode === 'activity') return Math.exp(-(t - c.t) / tau);
        if (typeof c.x !== 'number') return null;
        const xv = log ? logish(c.x) : c.x;
        return span > 0 ? (xv - mn) / span : 0.22; // constant rows stay dim so changes stand out
      };
    },
    describe(row, t) {
      const c = valueAt(row, t);
      return [{ text: c ? c.v?.s : 'not set yet', kind: 'code' }, c?.flag && { text: `⚠ ${c.sample?.reason}`, kind: 'warn' }].filter(Boolean);
    },
    ticks: row => row.changes,
    title: row => `${row.group} › ${row.label}${row.numeric ? ` · range ${row.min} … ${row.max}` : row.distinct != null ? ` · ${row.distinct} distinct values` : ''}`,
  };
}

// ---------------------------------------------------------------------------
// Activity Heatmap: how often each variable *changes*, independent of the
// magnitude of its values. Built once per run from a value model's
// row.changes; per-frame work is limited to binary searches.
// ---------------------------------------------------------------------------
export const ACTIVITY_WINDOWS = [1, 5, 10, 25];
export const DEFAULT_ACTIVITY_SETTINGS = { window: 5, smoothing: false, normalize: 'peak', sort: 'activity' };
const ACTIVITY_FLOOR = 0.12; // any real change stays visibly above "confirmed unchanged"

/** Identity of a recorded value. Snapshots compare by type, preview and
 * magnitude; raw primitives by type and value (so 1 ≠ "1"). */
export function valueKey(v) {
  if (v !== null && typeof v === 'object' && typeof v.s === 'string' && typeof v.t === 'string') return `${v.t}|${v.s}|${v.n ?? ''}`;
  if (typeof v === 'number' && Number.isNaN(v)) return 'number|NaN';
  return `${v === null ? 'null' : typeof v}|${String(v)}`;
}

/** Detect real value changes per row. The first observation is a baseline,
 * repeated identical assignments are not changes, and rows remember when
 * they were first observed so "missing" differs from "unchanged". */
export function buildActivityModel(model) {
  const length = Math.max(1, model?.length || 1);
  // Windows are measured in execution steps. Interpreter traces supply a
  // timeline-index -> statement-step map; flow simulations already use steps.
  const stepOf = model?.stepOf || null;
  const stepAt = stepOf ? t => stepOf[Math.max(0, Math.min(stepOf.length - 1, t))] : t => t;
  const rows = (model?.rows || []).map(row => {
    const eventTimes = [];
    let previous = null, first = null, observations = 0;
    for (const change of row.changes) {
      if (change.v === undefined) continue; // not an observation
      observations++;
      const key = valueKey(change.v);
      if (first === null) { first = change.t; previous = key; continue; }
      if (key !== previous) { eventTimes.push(change.t); previous = key; }
    }
    return {
      id: row.id, label: row.label, group: row.group, fnId: row.fnId, first, observations,
      eventTimes: Int32Array.from(eventTimes),    // timeline positions (drawing, seeking, playback)
      times: Int32Array.from(eventTimes, stepAt), // execution steps (rolling windows)
      profiles: new Map(), tickList: null,
    };
  });
  return { length, rows, peaks: new Map(), stepAt, stepped: Boolean(stepOf) };
}

/** Changes of a row inside the rolling window of steps (step − w, step]. */
export const changesInWindow = (row, step, w) => upperBound(row.times, step) - upperBound(row.times, step - w);

/** Per-row window counts at each change, with running maxima, cached per
 * window size. Lets statistics up to any playback position use one binary
 * search per row instead of rescanning the history. */
function windowProfile(row, w) {
  let profile = row.profiles.get(w);
  if (profile) return profile;
  const n = row.times.length, counts = new Int32Array(n), bestIndex = new Int32Array(n);
  for (let i = 0, lo = 0; i < n; i++) {
    while (row.times[lo] <= row.times[i] - w) lo++;
    counts[i] = i - lo + 1;
    bestIndex[i] = i === 0 || counts[i] > counts[bestIndex[i - 1]] ? i : bestIndex[i - 1];
  }
  profile = { counts, bestIndex };
  row.profiles.set(w, profile);
  return profile;
}
/** Highest window count anywhere in the run (keeps the colour scale stable). */
export function activityPeak(activity, w) {
  if (activity.peaks.has(w)) return activity.peaks.get(w);
  let peak = 0;
  for (const row of activity.rows) { const p = windowProfile(row, w); if (p.counts.length) peak = Math.max(peak, p.counts[p.bestIndex[p.counts.length - 1]]); }
  activity.peaks.set(w, peak);
  return peak;
}

/** Diagnostics for everything observed up to timeline index `upTo`. */
export function activityStats(activity, w, upTo = Infinity) {
  let totalChanges = 0, activeRows = 0, observedRows = 0, mostActive = null, peak = null;
  for (const row of activity.rows) {
    if (row.first === null || row.first > upTo) continue;
    observedRows++;
    const k = upperBound(row.eventTimes, upTo);
    if (!k) continue;
    totalChanges += k; activeRows++;
    if (!mostActive || k > mostActive.count) mostActive = { row, count: k };
    const profile = windowProfile(row, w);
    const best = profile.bestIndex[k - 1];
    if (!peak || profile.counts[best] > peak.count) peak = { row, count: profile.counts[best], step: row.times[best], t: row.eventTimes[best] };
  }
  return { totalChanges, activeRows, observedRows, rows: activity.rows.length, mostActive, peak, window: w };
}

/** Rows ordered by changes observed up to `upTo` (ties keep run order). */
export function sortByActivity(rows, upTo = Infinity) {
  return rows.map((row, index) => ({ row, index, count: upperBound(row.eventTimes, upTo) }))
    .sort((a, b) => b.count - a.count || a.index - b.index).map(entry => entry.row);
}

/** Activity sampler for the shared renderer. Intensity = changes in the
 * rolling window ÷ (run peak or window length), never the values themselves.
 * Smoothing blends in the two previous windows (causal: past activity only
 * decays, no change events are created). Positions at or beyond `revealed`
 * (not yet played back) are left empty. */
export function activitySampler(activity, settings, revealed = null) {
  const w = settings.window;
  const denominator = settings.normalize === 'absolute' ? w : Math.max(1, activityPeak(activity, w));
  const intensity = count => (count <= 0 ? 0 : ACTIVITY_FLOOR + (1 - ACTIVITY_FLOOR) * Math.min(1, count / denominator));
  return {
    key: `activity:${w}:${settings.smoothing}:${settings.normalize}:${revealed}`,
    legend: ['unchanged', settings.normalize === 'absolute' ? `${w} changes / ${w} steps` : `peak (${denominator} / ${w} steps)`],
    intensity,
    make(row) {
      const times = row.times, pointers = [0, 0, 0, 0]; // entries ≤ t − k·w
      return t => {
        if (row.first === null || t < row.first || (revealed != null && t >= revealed)) return null;
        const step = activity.stepAt(t);
        for (let k = 0; k < 4; k++) { const limit = step - k * w; while (pointers[k] < times.length && times[pointers[k]] <= limit) pointers[k]++; }
        const current = pointers[0] - pointers[1];
        const count = settings.smoothing ? (2 * current + (pointers[1] - pointers[2]) + (pointers[2] - pointers[3])) / 4 : current;
        return intensity(count);
      };
    },
    describe(row, t) {
      if (row.first === null || t < row.first) return [{ text: 'no observation yet', kind: 'meta' }];
      if (revealed != null && t >= revealed) return [{ text: 'not reached in playback yet', kind: 'meta' }];
      const step = activity.stepAt(t);
      const count = changesInWindow(row, step, w);
      return [
        { text: `${count} change${count === 1 ? '' : 's'} in last ${w} step${w === 1 ? '' : 's'}`, kind: 'code' },
        { text: `intensity ${Math.round(intensity(count) * 100)}% · ${upperBound(row.eventTimes, t)} changes so far${activity.stepped ? ` · statement step ${step}` : ''}`, kind: 'meta' },
      ];
    },
    ticks: row => row.tickList || (row.tickList = Array.from(row.eventTimes, t => ({ t }))),
    title: row => `${row.group} › ${row.label} · ${row.times.length} changes over ${row.observations} observations`,
  };
}
