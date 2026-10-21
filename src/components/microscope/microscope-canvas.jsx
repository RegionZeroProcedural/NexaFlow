import React, { memo, useCallback, useEffect, useRef } from 'react';
import { NODE_W, NODE_H, NODE_KINDS } from '../../scripts/microscope/dissect';

const KIND_SHORT = { entry: 'ENTRY', param: 'PARAM', literal: 'CONST', read: 'READ', this: 'THIS', declare: 'DECLARE', destructure: 'DESTRUCT', assign: 'ASSIGN', 'prop-write': 'SET PROP', update: 'UPDATE', arith: 'ALU', compare: 'COMPARE', logical: 'LOGIC', unary: 'UNARY', ternary: 'MUX ?:', member: 'GET PROP', object: 'OBJECT', array: 'ARRAY', template: 'STRING', spread: 'SPREAD', jsx: 'JSX', call: 'CALL', 'call-ext': 'EXTERN', method: 'METHOD', new: 'NEW', closure: 'FUNCTION', class: 'CLASS', await: 'AWAIT', yield: 'YIELD', if: 'BRANCH', loop: 'LOOP', switch: 'SWITCH', return: 'RETURN', throw: 'THROW', jump: 'JUMP', sequence: 'SEQ', expr: 'EXPR' };
const DIVEABLE = new Set(['call', 'closure', 'jsx', 'new', 'method', 'call-ext']);

const MxNode = memo(function MxNode({ node, state, selected, active, onSelect, onDive }) {
  const value = state?.value;
  const canDive = DIVEABLE.has(node.kind) && (node.targetId || state?.runtimeTarget);
  const pins = node.pins || 0;
  const status = active ? 'active' : state?.running ? 'running' : state ? (state.stale ? 'stale' : 'done') : 'idle';
  let readout = null;
  if (node.kind === 'if' || node.kind === 'ternary' || node.kind === 'logical') readout = state?.taken ? `${state.taken === 'then' || state.taken === 'right' ? '▶ ' : '▷ '}${state.taken}${state.test ? ` · ${state.test.s}` : ''}` : null;
  if (node.kind === 'loop') readout = state ? `${state.iter ? `pass ${state.iter}` : 'not entered'}${state.taken === 'exit' ? ' · exited' : ''}` : null;
  if (node.kind === 'switch') readout = state?.taken ? `→ ${state.taken}` : null;
  return <div data-mx-node={node.id} className={`mx-node kind-${node.kind} status-${status} ${selected ? 'selected' : ''} ${node.constant ? 'constant' : ''}`} style={{ left: node.x, top: node.y, width: NODE_W, height: NODE_H }}
    title={`${NODE_KINDS[node.kind]?.label || node.kind}${node.line ? ` · line ${node.line}` : ''}${node.sub ? `\n${node.sub}` : ''}${value ? `\nvalue: ${value.s}` : ''}`}
    onPointerDown={e => { e.stopPropagation(); onSelect(node.id); }}
    onDoubleClick={e => { e.stopPropagation(); if (canDive) onDive(node); }}>
    {Array.from({ length: Math.max(1, pins) }, (_, i) => <span key={i} className="mx-pin in" style={{ top: `${((i + 1) * 100) / (Math.max(1, pins) + 1)}%` }}/>)}
    <span className="mx-pin out"/>
    <div className="mx-node-top"><span className="mx-kind">{KIND_SHORT[node.kind] || node.kind}</span>{state?.hits > 1 && <span className="mx-hits">×{state.hits}</span>}{canDive && <button type="button" className="mx-dive" title={`Dive into ${node.targetName || 'function'} (double-click)`} onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onDive(node); }}>🔬</button>}</div>
    <div className="mx-label">{node.label}</div>
    <div className={`mx-value ${value ? `t-${value.t}` : ''}`}>{readout || (state?.running ? '⏳ running inside call…' : value ? `→ ${value.s}` : node.constant ? node.sub : node.sub || '')}</div>
  </div>;
});

function wirePath(a, b) {
  const dx = Math.max(30, Math.abs(b.x - a.x) * 0.5);
  return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
}
function varPath(a, b) {
  // Def→use wires arc above the die so they read as "same variable" links.
  const lift = Math.min(160, 40 + Math.abs(b.y - a.y) * 0.25 + Math.abs(b.x - a.x) * 0.08);
  return `M${a.x},${a.y} C${a.x + 60},${a.y - lift} ${b.x - 60},${b.y - lift} ${b.x},${b.y}`;
}

export default function MicroscopeCanvas({ die, states, regionStates, activeId, activeRowKey, selectedId, onSelect, onDive, showVarWires, transform, setTransform, autoCenter, fitSignal }) {
  const host = useRef(null);
  const drag = useRef(null);
  const tRef = useRef(transform);
  tRef.current = transform;

  const fit = useCallback(() => {
    const el = host.current; if (!el || !die) return;
    const r = el.getBoundingClientRect();
    const k = Math.max(0.12, Math.min(1, (r.width - 80) / die.width, (r.height - 120) / die.height));
    const scaledW = die.width * k;
    setTransform({ x: Math.max(40, (r.width - scaledW) / 2), y: 64, k });
  }, [die, setTransform]);
  useEffect(() => { const frame = requestAnimationFrame(fit); return () => cancelAnimationFrame(frame); }, [fit, fitSignal]);

  useEffect(() => {
    const el = host.current; if (!el) return undefined;
    const wheel = e => {
      e.preventDefault();
      const r = el.getBoundingClientRect(), t = tRef.current;
      const k = Math.max(0.08, Math.min(2.4, t.k * Math.exp(-e.deltaY * 0.0014)));
      const px = e.clientX - r.left, py = e.clientY - r.top;
      setTransform({ k, x: px - (px - t.x) * (k / t.k), y: py - (py - t.y) * (k / t.k) });
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [setTransform]);
  useEffect(() => {
    const move = e => { const d = drag.current; if (!d) return; setTransform({ ...tRef.current, x: d.x + e.clientX - d.sx, y: d.y + e.clientY - d.sy }); };
    const up = () => { drag.current = null; };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [setTransform]);

  // Keep the executing node in view while stepping/playing.
  useEffect(() => {
    if (!autoCenter || !activeId || !die) return;
    const node = die.byId.get(activeId); const el = host.current;
    if (!node || !el) return;
    const r = el.getBoundingClientRect(), t = tRef.current;
    const sx = node.x * t.k + t.x, sy = node.y * t.k + t.y;
    const margin = 90;
    if (sx < margin || sy < margin + 30 || sx + NODE_W * t.k > r.width - margin || sy + NODE_H * t.k > r.height - margin) {
      const k = Math.max(t.k, 0.55);
      setTransform({ k, x: r.width / 2 - (node.x + NODE_W / 2) * k, y: r.height / 2 - (node.y + NODE_H / 2) * k });
    }
  }, [activeId, autoCenter, die, setTransform]);

  if (!die) return <div className="mx-canvas" ref={host}/>;
  const pos = (id, side, pin = 0, pins = 1) => {
    const n = die.byId.get(id); if (!n) return null;
    return side === 'out' ? { x: n.x + NODE_W, y: n.y + NODE_H / 2 } : { x: n.x, y: n.y + (NODE_H * (pin + 1)) / (pins + 1) };
  };
  const selectedVarWires = die.varWires.filter(w => showVarWires || w.from === selectedId || w.to === selectedId);
  // Panning keeps the selection (and its highlighted variable wires); only
  // selecting another node or double-clicking empty canvas clears it.
  return <div className="mx-canvas" ref={host} onPointerDown={e => { if (e.button !== 0 && e.button !== 1) return; drag.current = { sx: e.clientX, sy: e.clientY, x: tRef.current.x, y: tRef.current.y }; }} onDoubleClick={e => { if (!e.target.closest('[data-mx-node]')) onSelect(null); }}>
    <div className="mx-stage" style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.k})` }}>
      <svg className="mx-svg" width={die.width + 40} height={die.height + 40} style={{ overflow: 'visible' }}>
        <defs>
          <marker id="mx-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#7d86b8"/></marker>
          <pattern id="mx-die-grid" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M24 0 L0 0 0 24" fill="none" stroke="#ffffff08" strokeWidth="1"/></pattern>
        </defs>
        {die.regions.map((r, i) => {
          const st = regionStates.get(i);
          return <g key={i} className={`mx-region kind-${r.kind} ${st?.state ? `state-${st.state}` : ''}`}>
            <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={r.root ? 18 : 12} fill={r.root ? 'url(#mx-die-grid)' : undefined}/>
            <text x={r.x + 14} y={r.y + 19}>{r.label}{st?.badge ? `  ·  ${st.badge}` : ''}</text>
            {r.loopBody && <path className="mx-backedge" d={`M${r.x + r.w - 10},${r.y + r.h - 8} C${r.x + r.w + 26},${r.y + r.h - 8} ${r.x + r.w + 26},${r.y + 8} ${r.x + r.w - 10},${r.y + 8}`} markerEnd="url(#mx-arrow)"/>}
          </g>;
        })}
        {die.rows.map((row, i) => <rect key={i} className={`mx-row ${row.key === activeRowKey ? 'active' : ''}`} x={row.x + 2} y={row.y - 5} width={row.w + 6} height={row.h + 10} rx="8"/>)}
        {die.wires.map((w, i) => {
          const a = pos(w.from, 'out'), b = pos(w.to, 'in', w.pin, w.pins);
          if (!a || !b) return null;
          const flowing = w.to === activeId && states.get(w.from);
          const carried = states.get(w.from) && states.get(w.to);
          return <g key={i} className={`mx-wire ${flowing ? 'flowing' : carried ? 'carried' : ''}`}>
            <path d={wirePath(a, b)}/>
            {w.label && <text x={b.x - 8} y={b.y - 5} textAnchor="end">{w.label}</text>}
            {flowing && <circle r="5" className="mx-packet"><animateMotion dur="0.55s" repeatCount="indefinite" path={wirePath(a, b)}/></circle>}
          </g>;
        })}
        {selectedVarWires.map((w, i) => {
          const a = pos(w.from, 'out'), bNode = die.byId.get(w.to);
          if (!a || !bNode) return null;
          const b = { x: bNode.x + NODE_W / 2, y: bNode.y };
          return <g key={`v${i}`} className={`mx-varwire ${w.loopCarried ? 'loop' : ''} ${w.from === selectedId || w.to === selectedId ? 'focus' : ''}`}><path d={varPath(a, b)} markerEnd="url(#mx-arrow)"/><text x={(a.x + b.x) / 2} y={Math.min(a.y, b.y) - 18}>{w.label}{w.loopCarried ? ' ↻' : ''}</text></g>;
        })}
      </svg>
      {die.nodes.map(n => <MxNode key={n.id} node={n} state={states.get(n.id)} selected={n.id === selectedId} active={n.id === activeId} onSelect={onSelect} onDive={onDive}/>)}
    </div>
  </div>;
}
