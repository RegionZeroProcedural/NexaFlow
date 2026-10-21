import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MicroscopeCanvas from './microscope-canvas';
import FunctionSearch from '../function-search';
import { dissectFunction, indexTrace, NODE_KINDS } from '../../scripts/microscope/dissect';
import { traceFunction } from '../../scripts/microscope/interpreter';
import useEdgeReveal from '../../scripts/use-edge-reveal';
import WaterfallInspector from '../waterfall-inspector';
import { heatmapFromTrace, watchSamplesFromTrace } from '../../scripts/heatmap';

const VALUE_KINDS = new Set(['eval', 'write', 'return', 'branch', 'iter', 'throw', 'catch', 'call', 'await', 'yield']);

/** Precompute lookups for a finished trace so playback stays fast. */
function prepareRun(result, rootFnId, args) {
  const events = result.events;
  const valueEvents = events.map((e, i) => (e.key && VALUE_KINDS.has(e.k) ? e : null));
  const byKey = indexTrace(valueEvents.map(e => e || {}));
  const frames = new Map(), writesByFrame = new Map(), fnFrames = new Map();
  events.forEach((e, i) => {
    if (e.k === 'enter') {
      frames.set(e.frame, { frame: e.frame, fn: e.fn, name: e.name, enter: i, exit: null, callerFrame: e.callerFrame, call: e.call, args: e.args });
      if (!fnFrames.has(e.fn)) fnFrames.set(e.fn, []);
      fnFrames.get(e.fn).push(e.frame);
    } else if (e.k === 'exit' && frames.has(e.frame)) { frames.get(e.frame).exit = i; frames.get(e.frame).result = e.v; frames.get(e.frame).threw = e.threw; }
    if (e.k === 'write') { if (!writesByFrame.has(e.frame)) writesByFrame.set(e.frame, []); writesByFrame.get(e.frame).push(i); }
  });
  return { ...result, rootFnId, args, byKey, frames, writesByFrame, fnFrames, at: Date.now() };
}
const countUpTo = (list, limit) => { let lo = 0, hi = list.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid] <= limit) lo = mid + 1; else hi = mid; } return lo; };

function SourceView({ project, fn, highlight, active, onPickLine }) {
  const file = project.files[fn.path];
  const startLine = fn.line;
  const lines = file.text.slice(fn.start, fn.end).split('\n');
  const before = file.text.slice(0, fn.start).split('\n').pop();
  const lineOf = offset => offset == null ? null : file.text.slice(0, offset).split('\n').length;
  const hiStart = lineOf(highlight?.start), hiEnd = lineOf(highlight?.end), acStart = lineOf(active?.start);
  return <pre className="mx-source">{lines.map((line, i) => {
    const n = startLine + i;
    return <div key={i} className={`mx-source-line ${n >= hiStart && n <= hiEnd ? 'hi' : ''} ${n === acStart ? 'ac' : ''}`} onClick={() => onPickLine(n)}><span className="ln">{n}</span><code>{i === 0 ? ' '.repeat(Math.min(before.length, 40)) + line : line}</code></div>;
  })}</pre>;
}

export default function MicroscopePage({ project, initialFnId, onClose, onShowOnBoard, notify, argTexts, setArgTexts, watchpoints = [] }) {
  const [fnId, setFnId] = useState(initialFnId);
  const [history, setHistory] = useState([initialFnId]);
  const [selectedId, setSelectedId] = useState(null);
  const [run, setRun] = useState(null);
  const [cursor, setCursor] = useState(0);
  const [revealed, setRevealed] = useState(0); // furthest playback position (kept when rewinding)
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(3);
  const [follow, setFollow] = useState(true);
  const [autoCenter, setAutoCenter] = useState(true);
  const [showVarWires, setShowVarWires] = useState(false);
  const [waterfallCollapsed, setWaterfallCollapsed] = useState(false);
  const [tab, setTab] = useState('run');
  const [busy, setBusy] = useState(false);
  const [transform, setTransform] = useState({ x: 40, y: 64, k: 0.8 });
  const [fitSignal, setFitSignal] = useState(0);
  const [toolsPinned, setToolsPinned] = useState(false);
  const [playPinned, setPlayPinned] = useState(false);
  const tools = useEdgeReveal(toolsPinned);
  const playback = useEdgeReveal(playPinned);
  const fn = project.functions[fnId];

  useEffect(() => { setFnId(initialFnId); setHistory(h => (h[h.length - 1] === initialFnId ? h : [...h, initialFnId])); }, [initialFnId]);
  const die = useMemo(() => {
    try { return dissectFunction(project, fnId); } catch (error) { return { error: error.message }; }
  }, [project, fnId]);
  const navigate = useCallback((id, push = true) => {
    if (!project.functions[id]) { notify?.('That function is not part of the imported project (anonymous or external).', 'error'); return; }
    setFnId(id); setSelectedId(null);
    if (push) setHistory(h => [...h.slice(-30), id]);
  }, [project, notify]);

  const events = run?.events || [];
  const current = cursor > 0 ? events[cursor - 1] : null;

  // ---------- Derived playback state for the visible function ----------
  const view = useMemo(() => {
    const states = new Map(), regionStates = new Map();
    if (!run || die.error) return { states, regionStates, focusFrame: null, activeRowKey: null };
    const upto = cursor - 1;
    let focusFrame = null;
    if (current && current.fn === fnId) focusFrame = current.frame;
    else {
      // Prefer the invocation that is on the current call stack, else the latest one.
      for (let f = current?.frame; f; f = run.frames.get(f)?.callerFrame) if (run.frames.get(f)?.fn === fnId) { focusFrame = f; break; }
      if (focusFrame == null) for (const f of [...(run.fnFrames.get(fnId) || [])].reverse()) if (run.frames.get(f).enter <= upto) { focusFrame = f; break; }
    }
    if (focusFrame == null) return { states, regionStates, focusFrame: null, activeRowKey: null };
    const frameInfo = run.frames.get(focusFrame);
    const finished = frameInfo?.exit != null && frameInfo.exit <= upto;
    for (const node of die.nodes) {
      const list = run.byKey.get(node.id);
      if (!list) continue;
      const n = countUpTo(list, upto);
      if (!n) continue;
      const st = { hits: 0, stale: false };
      let gotValue = false, gotTaken = false, gotIter = false, steps = 0;
      for (let j = n - 1; j >= 0 && steps < 600; j--, steps++) {
        const e = events[list[j]];
        if (e.frame !== focusFrame) continue;
        if (e.k === 'eval' || e.k === 'write' || e.k === 'return') st.hits++;
        if (!gotValue && e.v && e.k !== 'branch' && e.k !== 'call') { st.value = e.v; gotValue = true; }
        if (!gotValue && e.k === 'call' && !st.running) { st.running = true; st.runtimeTarget = e.callee; }
        if (e.k === 'call' && e.callee && !st.runtimeTarget) st.runtimeTarget = e.callee;
        if (!gotTaken && e.k === 'branch') { st.taken = e.taken; st.test = e.v; gotTaken = true; }
        if (!gotIter && e.k === 'iter') { st.iter = e.n; gotIter = true; }
      }
      if (st.hits || st.value || st.taken || st.iter || st.running) {
        if (finished) st.running = false;
        states.set(node.id, st);
      }
    }
    die.regions.forEach((r, i) => {
      if (!r.key) return;
      if (r.branch) {
        const owner = states.get(r.switchKey || r.key);
        if (owner?.taken) regionStates.set(i, { state: owner.taken === r.branch || (r.switchKey && owner.taken === r.branch) ? 'taken' : 'skipped' });
      } else if (r.loop) {
        const owner = states.get(r.key);
        if (owner) regionStates.set(i, { state: 'taken', badge: owner.iter ? `${owner.iter} pass${owner.iter === 1 ? '' : 'es'}${owner.taken === 'exit' ? ' · done' : ''}` : '0 passes' });
      } else if (r.kind === 'catch') {
        const list = run.byKey.get(r.key);
        if (list && countUpTo(list, upto)) regionStates.set(i, { state: 'taken', badge: 'error caught' });
      }
    });
    let activeRowKey = null;
    for (let i = upto, guard = 0; i >= 0 && guard < 20000; i--, guard++) { const e = events[i]; if (e.k === 'stmt' && e.frame === focusFrame) { activeRowKey = e.key; break; } }
    return { states, regionStates, focusFrame, activeRowKey };
  }, [run, die, cursor, current, fnId, events]);

  const activeId = current && current.fn === fnId && current.key && die.byId?.has(current.key) ? current.key : null;

  // ---------- Back: up one layer (previous function), then the board ----------
  const goBack = useCallback(() => {
    setSelectedId(null);
    const last = history[history.length - 1];
    if (last && last !== fnId && project.functions[last]) { setFnId(last); return; } // e.g. after "Follow calls" moved the view
    if (history.length > 1) { setHistory(history.slice(0, -1)); setFnId(history[history.length - 2]); return; }
    onClose();
  }, [history, fnId, project, onClose]);
  const backTarget = (() => {
    const last = history[history.length - 1];
    if (last && last !== fnId && project.functions[last]) return project.functions[last];
    return history.length > 1 ? project.functions[history[history.length - 2]] : null;
  })();
  const fnIdRef = useRef(fnId);
  fnIdRef.current = fnId;

  // ---------- Follow execution into callees ----------
  useEffect(() => {
    if (!follow || !current || !run) return;
    if (current.fn && current.fn !== fnIdRef.current && project.functions[current.fn] && (current.k === 'enter' || current.k === 'eval' || current.k === 'stmt')) setFnId(current.fn);
  }, [follow, current, run, project]);

  useEffect(() => { setRevealed(r => Math.max(r, cursor)); }, [cursor]);
  // ---------- Playback ----------
  useEffect(() => {
    if (!playing || !run) return undefined;
    if (cursor >= events.length) { setPlaying(false); return undefined; }
    const per = [1, 1, 2, 5, 15, 60, 250][speed];
    const delay = [600, 260, 120, 60, 40, 30, 30][speed];
    const timer = setTimeout(() => setCursor(c => Math.min(events.length, c + per)), delay);
    return () => clearTimeout(timer);
  }, [playing, run, cursor, events.length, speed]);
  const stepInto = useCallback(() => { setPlaying(false); setCursor(c => Math.min(events.length, c + 1)); }, [events.length]);
  const stepBack = useCallback(() => { setPlaying(false); setCursor(c => Math.max(0, c - 1)); }, []);
  const stepOver = useCallback(() => {
    setPlaying(false);
    setCursor(c => { const depth = events[c - 1]?.depth ?? 0; for (let i = c; i < events.length; i++) if ((events[i].depth ?? 0) <= depth && events[i].k !== 'exit') return i + 1; return events.length; });
  }, [events]);
  const stepOut = useCallback(() => {
    setPlaying(false);
    setCursor(c => { const depth = events[c - 1]?.depth ?? 0; for (let i = c; i < events.length; i++) if ((events[i].depth ?? 0) < depth) return i + 1; return events.length; });
  }, [events]);
  const nextStatement = useCallback(() => {
    setPlaying(false);
    setCursor(c => { for (let i = c; i < events.length; i++) if (events[i].k === 'stmt' && events[i].fn === fnId) return i + 1; return events.length; });
  }, [events, fnId]);

  const runFunction = useCallback((targetId = fnId) => {
    const target = project.functions[targetId];
    if (!target) return;
    setBusy(true);
    setTimeout(() => {
      const args = (argTexts[targetId] || []).slice(0, target.params.length);
      while (args.length < target.params.length) args.push('');
      const result = traceFunction(project, targetId, args);
      const prepared = prepareRun(result, targetId, args);
      prepared.heatmap = heatmapFromTrace(result.events, project);
      prepared.samples = watchSamplesFromTrace(result.events, watchpoints);
      setRun(prepared); setCursor(0); setRevealed(0); setPlaying(true); setBusy(false); setTab('run');
      if (targetId !== fnId) navigate(targetId);
      notify?.(result.halted ? `Stopped: ${result.halted}` : result.error ? `Finished with ${result.error}` : `Traced ${target.name}() · ${result.events.length.toLocaleString()} events`, result.error || result.halted ? 'error' : 'success');
    }, 20);
  }, [project, fnId, argTexts, navigate, notify, watchpoints]);

  useEffect(() => {
    const key = e => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
      if ((e.key === 'Escape' && !selectedId) || (e.altKey && e.key === 'ArrowLeft')) { e.preventDefault(); goBack(); return; }
      if (e.key === 'Escape') setSelectedId(null);
      if (!run) { if (e.key === 'F5') { e.preventDefault(); runFunction(); } return; }
      if (e.key === 'ArrowRight' || e.key === 'F11') { e.preventDefault(); if (e.shiftKey) stepOut(); else stepInto(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); stepBack(); }
      else if (e.key === 'F10' || e.key === 'ArrowDown') { e.preventDefault(); stepOver(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); stepOut(); }
      else if (e.key === ' ') { e.preventDefault(); if (cursor >= events.length) setCursor(0); setPlaying(p => !p); }
      else if (e.key === 'F5') { e.preventDefault(); runFunction(); }
      else if (e.key === 'Home') setCursor(0);
      else if (e.key === 'End') setCursor(events.length);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [run, stepInto, stepBack, stepOver, stepOut, cursor, events.length, runFunction, goBack, selectedId]);

  // Leave replay mode without closing the microscope: clear the trace and
  // return to the function the run started from, in its static view.
  const exitSimulation = useCallback(() => {
    const origin = run?.rootFnId;
    setPlaying(false); setRun(null); setCursor(0); setRevealed(0);
    if (origin && origin !== fnId && project.functions[origin]) navigate(origin);
    setFitSignal(n => n + 1);
  }, [run, fnId, project, navigate]);
  const waterfallRun = useMemo(() => (run ? { hasRun: true, heatmap: run.heatmap, samples: run.samples, total: run.events.length, unit: 'event' } : null), [run]);
  const onDive = useCallback(node => {
    const target = node.targetId || view.states.get(node.id)?.runtimeTarget;
    if (target && project.functions[target]) navigate(target);
    else notify?.(node.external ? `${node.external} is outside the imported project.` : 'This call has no resolved project target yet — run the trace to discover dynamic targets.', 'info');
  }, [view, project, navigate, notify]);

  // ---------- Panels ----------
  const selected = selectedId && die.byId?.get(selectedId);
  const locals = useMemo(() => {
    if (!run || view.focusFrame == null) return [];
    const list = run.writesByFrame.get(view.focusFrame) || [];
    const latest = new Map();
    for (const i of list) { if (i > cursor - 1) break; const e = events[i]; latest.set(e.name, { v: e.v, i, prop: e.prop }); }
    return [...latest.entries()];
  }, [run, view.focusFrame, cursor, events]);
  const callStack = useMemo(() => {
    if (!run || !current) return [];
    const out = [];
    for (let f = current.frame; f && out.length < 60; f = run.frames.get(f)?.callerFrame) { const info = run.frames.get(f); if (!info) break; out.push(info); }
    return out;
  }, [run, current]);
  const history_ = selected && run ? (run.byKey.get(selected.id) || []).filter(i => i <= cursor - 1).slice(-120).map(i => events[i]).filter(e => e.v || e.taken || e.n) : [];
  const consoleUpTo = run ? events.slice(0, cursor).filter(e => e.k === 'log').slice(-200) : [];
  const args = argTexts[fnId] || [];

  if (!fn) return null;
  const callers = fn.callers.map(id => project.functions[id]).filter(Boolean);
  const callees = [...new Map(fn.calls.filter(c => c.targetId).map(c => [c.targetId, project.functions[c.targetId]])).values()];
  const externals = [...new Set(fn.calls.filter(c => c.external).map(c => c.external))];
  const runFn = run && project.functions[run.rootFnId];

  return <div className="microscope-page" role="dialog" aria-label={`Microscope: ${fn.name}`}>
    <header className="mx-header">
      <button type="button" className="mx-back" onClick={goBack} title={`Back up one layer${backTarget ? ` to ${backTarget.name}()` : ' to the call board'} (Esc / Alt+←)`}>← {backTarget ? backTarget.name.split(' › ').pop() : 'Board'}</button>
      {backTarget && <button type="button" className="mx-header-button mx-board" onClick={onClose} title="Close the microscope and return to the call board">⌂ Board</button>}
      <div className="mx-title">
        <div className="mx-crumbs">{history.slice(-6).map((id, i, arr) => <React.Fragment key={`${id}-${i}`}><button type="button" className={id === fnId ? 'current' : ''} onClick={() => navigate(id, false)}>{project.functions[id]?.name.split(' › ').pop() || '?'}</button>{i < arr.length - 1 && <span>›</span>}</React.Fragment>)}</div>
        <h1>🔬 {fn.qualifiedName}<span>({fn.params.join(', ')})</span></h1>
        <small>{fn.path}:{fn.line}–{fn.endLine} · {fn.kind}{fn.async ? ' · async' : ''}{fn.generator ? ' · generator' : ''} · {die.stats?.nodes ?? 0} nodes · {die.stats?.branches ?? 0} branches · {die.stats?.loops ?? 0} loops · {die.stats?.calls ?? 0} calls</small>
      </div>
      <FunctionSearch project={project} onOpen={id => navigate(id)} onShowOnBoard={onShowOnBoard} compact/>
      <button type="button" className="mx-header-button" onClick={() => onShowOnBoard(fnId)}>Show on board</button>
      {run && <button type="button" className="mx-header-button mx-exit-sim" onClick={exitSimulation} title="Clear the trace and go back to the static view">✕ Exit simulation</button>}
      <button type="button" className="primary-button mx-run" disabled={busy} onClick={() => runFunction()}>{busy ? 'Tracing…' : `▶ Run ${fn.name.split('.').pop().split(' › ').pop()}()`}</button>
    </header>
    <div className="mx-body">
      <div className="mx-column">
      <main className="mx-main">
        {die.error ? <div className="mx-error">Could not dissect this function: {die.error}</div> : <MicroscopeCanvas die={die} states={view.states} regionStates={view.regionStates} activeId={activeId} activeRowKey={view.activeRowKey} selectedId={selectedId} onSelect={setSelectedId} onDive={onDive} showVarWires={showVarWires} transform={transform} setTransform={setTransform} autoCenter={autoCenter && Boolean(run)} fitSignal={`${fnId}:${fitSignal}`}/>}
        {die.truncated && <div className="mx-banner">This function is very large; deep sub-expressions were collapsed into EXPR nodes.</div>}
        {run && view.focusFrame == null && <div className="mx-banner subtle">{run.fnFrames.has(fnId) ? 'This function runs later in the trace — keep stepping or scrub forward.' : `This function was not called in the current trace of ${runFn?.name || '?'}(). Run it directly with ▶ Run.`}</div>}

        <div className={`mx-reveal top ${tools.open ? 'is-open' : ''}`}>
          <button ref={tools.tabRef} type="button" className="reveal-tab top-tab" aria-expanded={tools.open} onPointerEnter={tools.reveal} onFocus={tools.reveal} onClick={() => setToolsPinned(v => !v)}>⌄ View tools{toolsPinned ? ' · pinned' : ''}</button>
          <div ref={tools.toolbarRef} className="mx-toolbar">
            <button type="button" onClick={() => setTransform(t => ({ ...t, k: Math.max(0.08, t.k / 1.2) }))} title="Zoom out">−</button>
            <span className="zoom-label">{Math.round(transform.k * 100)}%</span>
            <button type="button" onClick={() => setTransform(t => ({ ...t, k: Math.min(2.4, t.k * 1.2) }))} title="Zoom in">+</button>
            <button type="button" onClick={() => setFitSignal(s => s + 1)} title="Fit the whole function">Fit</button>
            <span className="mx-tool-divider"/>
            <label><input type="checkbox" checked={showVarWires} onChange={e => setShowVarWires(e.target.checked)}/> Variable wires</label>
            <label title="Switch the view into whichever function is executing"><input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)}/> Follow calls</label>
            <label><input type="checkbox" checked={autoCenter} onChange={e => setAutoCenter(e.target.checked)}/> Auto-center</label>
          </div>
        </div>

        <div className={`mx-reveal bottom ${playback.open ? 'is-open' : ''}`}>
          <button ref={playback.tabRef} type="button" className="reveal-tab bottom-tab" aria-expanded={playback.open} onPointerEnter={playback.reveal} onFocus={playback.reveal} onClick={() => setPlayPinned(v => !v)}>⌃ Playback {run ? `· ${cursor}/${events.length}` : ''}{playing ? ' • playing' : ''}{playPinned ? ' · pinned' : ''}</button>
          <div ref={playback.toolbarRef} className="mx-toolbar mx-playback">
            {!run ? <><span className="mx-hint">No trace yet.</span><button type="button" className="small-run-button" onClick={() => runFunction()}>▶ Run</button></> : <>
              <button type="button" onClick={() => setCursor(0)} title="Restart (Home)">⏮</button>
              <button type="button" onClick={stepBack} disabled={cursor <= 0} title="Step back (←)">◀</button>
              <button type="button" onClick={() => { if (cursor >= events.length) setCursor(0); setPlaying(p => !p); }} title="Play / pause (Space)">{playing ? '⏸' : '▶'}</button>
              <button type="button" onClick={stepInto} title="Step into — next event (→ / F11)">Step</button>
              <button type="button" onClick={stepOver} title="Step over calls (↓ / F10)">Over</button>
              <button type="button" onClick={stepOut} title="Step out of this call (↑ / Shift+F11)">Out</button>
              <button type="button" onClick={nextStatement} title="Next statement in this function">Next stmt</button>
              <input type="range" min={0} max={events.length} value={cursor} onChange={e => { setPlaying(false); setCursor(Number(e.target.value)); }} aria-label="Trace position"/>
              <span className="step-meter">{cursor}/{events.length}</span>
              <label className="mx-speed">speed<input type="range" min={0} max={6} value={speed} onChange={e => setSpeed(Number(e.target.value))}/></label>
            </>}
          </div>
        </div>
        {current && <div className="mx-now"><span className={`mx-now-kind k-${current.k}`}>{current.k}</span>{describeEvent(current, project)}</div>}
      </main>
      <WaterfallInspector className="mx-waterfall" title="Execution Waterfall" run={waterfallRun} cursor={run ? cursor : null} revealed={run ? Math.max(revealed, cursor) : null} isPlaying={playing} collapsed={waterfallCollapsed} setCollapsed={setWaterfallCollapsed} onSeek={run ? (t => { setPlaying(false); setCursor(t + 1); }) : null}/>
      </div>

      <aside className="mx-panel">
        <div className="mx-tabs">{['run', 'node', 'locals', 'calls', 'source', 'legend'].map(t => <button key={t} type="button" className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t === 'node' && selected ? 'node •' : t}</button>)}</div>
        <div className="mx-panel-scroll">
          {tab === 'run' && <>
            <section className="mx-section">
              <h3>Arguments for {fn.name.split(' › ').pop()}()</h3>
              {fn.params.length ? fn.params.map((p, i) => <label key={i} className="mx-arg"><span>{p}</span><input value={args[i] ?? ''} placeholder="undefined" spellCheck="false" onChange={e => { const next = [...args]; next[i] = e.target.value; setArgTexts(a => ({ ...a, [fnId]: next })); }} onKeyDown={e => { if (e.key === 'Enter') runFunction(); }}/></label>) : <p className="mx-muted">No parameters.</p>}
              <p className="mx-muted">Any JavaScript expression: <code>42</code>, <code>"text"</code>, <code>{'{ items: [1, 2] }'}</code>, <code>new Map()</code>, or names defined in <code>{fn.path.split('/').pop()}</code>.</p>
              <button type="button" className="primary-button" disabled={busy} onClick={() => runFunction()}>{busy ? 'Tracing…' : '▶ Run & trace (F5)'}</button>
            </section>
            {run && <section className="mx-section">
              <h3>Trace of {runFn?.name}()</h3>
              <button type="button" className="mx-link" onClick={exitSimulation}>✕ Exit simulation · back to the static view</button>
              <div className={`mx-result ${run.error || run.halted ? 'bad' : 'good'}`}>{run.halted ? `⛔ ${run.halted}` : run.error ? `⚠ ${run.error}` : <>returned <code>{run.value?.s}</code></>}</div>
              <p className="mx-muted">{run.events.length.toLocaleString()} events · {run.frames.size} calls{run.approximate ? ' · approximate (see notes)' : ''}</p>
              {run.notes.length > 0 && <ul className="mx-notes">{run.notes.slice(0, 12).map((n, i) => <li key={i}>{n}</li>)}</ul>}
              <h4>Console</h4>
              {consoleUpTo.length ? <div className="mx-console">{consoleUpTo.map((e, i) => <div key={i} className={`lvl-${e.level}`} onClick={() => setCursor(e.i + 1)}>{e.text}</div>)}</div> : <p className="mx-muted">No console output yet.</p>}
            </section>}
            <section className="mx-section mx-muted small">
              The code is interpreted step by step inside a sandbox; it is never executed natively. Unknown globals, npm packages, DOM and network are shown as <code>‹external›</code> values. Keys: → step, ← back, ↓ over, ↑ out, Space play.
            </section>
          </>}
          {tab === 'node' && (selected ? <section className="mx-section">
            <h3>{NODE_KINDS[selected.kind]?.label || selected.kind}</h3>
            <div className="mx-node-title">{selected.label}</div>
            {selected.line && <p className="mx-muted">Line {selected.line}{selected.sub ? ` · ${selected.sub}` : ''}</p>}
            {selected.start != null && <pre className="mx-snippet">{project.files[fn.path].text.slice(selected.start, Math.min(selected.end, selected.start + 600))}</pre>}
            {(selected.targetId || selected.external) && <div className="mx-target">{selected.targetId ? <><span>Connects to</span><button type="button" onClick={() => navigate(selected.targetId)}>🔬 {project.functions[selected.targetId]?.name}</button><small>{project.functions[selected.targetId]?.path}:{project.functions[selected.targetId]?.line}</small></> : <><span>External</span><code>{selected.external}</code></>}</div>}
            {run && (() => {
              const enters = [...run.frames.values()].filter(f => f.call === selected.id).slice(0, 40);
              return enters.length ? <><h4>Invocations from here</h4><div className="mx-history">{enters.map(f => <button key={f.frame} type="button" onClick={() => { setCursor(f.enter + 1); }}>{project.functions[f.fn]?.name || f.name || 'anonymous'}({f.args?.map(a => a.s).join(', ')}) {f.exit != null ? `→ ${f.result?.s}` : ''}</button>)}</div></> : null;
            })()}
            <h4>Value history {run ? `(${history_.length})` : ''}</h4>
            {history_.length ? <div className="mx-history">{history_.map((e, i) => <button key={i} type="button" className={e.i === cursor - 1 ? 'current' : ''} onClick={() => { setPlaying(false); setCursor(e.i + 1); }}><span className="mx-history-meta">#{e.i} · {e.k}{e.n ? ` ${e.n}` : ''}{e.frame !== view.focusFrame ? ` · call ${e.frame}` : ''}</span>{e.taken ? `${e.taken} ` : ''}{e.v ? e.v.s : ''}</button>)}</div> : <p className="mx-muted">{run ? 'No values for this node yet at this point of the trace.' : 'Run the function to collect values.'}</p>}
          </section> : <p className="mx-muted mx-section">Click a node to inspect its source, connections and value history. Double-click (or 🔬) a call to dive into that function.</p>)}
          {tab === 'locals' && <section className="mx-section">
            <h3>Variables in this call</h3>
            {locals.length ? <table className="mx-locals"><tbody>{locals.map(([name, info]) => <tr key={name} onClick={() => setCursor(info.i + 1)}><td>{name}</td><td className={`t-${info.v.t}`}>{info.v.s}</td></tr>)}</tbody></table> : <p className="mx-muted">{run ? 'No variables written yet in this call.' : 'Run the function to see live variables.'}</p>}
            {die.freeVariables?.length > 0 && <><h4>Read from outer scope</h4><p className="mx-muted">{die.freeVariables.join(', ')}</p></>}
            <h3>Call stack</h3>
            {callStack.length ? <ol className="mx-stack">{callStack.map(f => <li key={f.frame}><button type="button" onClick={() => project.functions[f.fn] && navigate(f.fn)}>{project.functions[f.fn]?.name || f.name || 'anonymous'}</button><small>({f.args?.map(a => a.s).join(', ')})</small></li>)}</ol> : <p className="mx-muted">Not running.</p>}
          </section>}
          {tab === 'calls' && <section className="mx-section">
            <h3>Called by ({callers.length})</h3>
            {callers.length ? callers.map(c => <button key={c.id} type="button" className="mx-link" onClick={() => navigate(c.id)}>← {c.name}<small>{c.path}:{c.line}</small></button>) : <p className="mx-muted">No static callers found (entry point, callback, or called dynamically).</p>}
            <h3>Calls ({callees.length})</h3>
            {callees.map(c => <button key={c.id} type="button" className="mx-link" onClick={() => navigate(c.id)}>→ {c.name}<small>{c.path}:{c.line}</small></button>)}
            {externals.length > 0 && <><h3>External calls</h3><p className="mx-muted">{externals.slice(0, 40).join(' · ')}</p></>}
          </section>}
          {tab === 'source' && <SourceView project={project} fn={fn} highlight={selected} active={activeId && die.byId.get(activeId)} onPickLine={line => { const node = die.nodes.find(n => n.line === line && n.kind !== 'literal'); if (node) { setSelectedId(node.id); setTab('node'); } }}/>}
          {tab === 'legend' && <section className="mx-section mx-legend">{Object.entries(NODE_KINDS).map(([kind, meta]) => <div key={kind} className="mx-legend-row"><span className={`mx-swatch kind-${kind}`}/>{meta.label}<small>{meta.group}</small></div>)}</section>}
        </div>
      </aside>
    </div>
  </div>;
}

function describeEvent(e, project) {
  const where = project.functions[e.fn]?.name || (e.fn?.startsWith('module:') ? 'module setup' : 'anonymous');
  switch (e.k) {
    case 'enter': return `enter ${where}(${(e.args || []).map(a => a.s).join(', ')})`;
    case 'exit': return `${where} ${e.threw ? 'threw' : 'returned'} ${e.v?.s ?? ''}`;
    case 'eval': return `${where}: value ${e.v?.s}`;
    case 'write': return `${where}: ${e.name} = ${e.v?.s}`;
    case 'branch': return `${where}: took ${e.taken}${e.v ? ` (test ${e.v.s})` : ''}`;
    case 'iter': return `${where}: loop pass ${e.n}`;
    case 'call': return `${where}: calling ${project.functions[e.callee]?.name || e.native || e.external || 'function'}(${(e.args || []).map(a => a.s).join(', ')})`;
    case 'log': return `console.${e.level}: ${e.text}`;
    case 'external': return `${where}: ${e.label}`;
    case 'return': return `${where}: return ${e.v?.s}`;
    case 'throw': return `${where}: throw ${e.v?.s}`;
    case 'catch': return `${where}: caught ${e.v?.s}`;
    case 'stmt': return `${where}: statement`;
    default: return `${where}: ${e.k}${e.text ? ` ${e.text}` : ''}`;
  }
}
