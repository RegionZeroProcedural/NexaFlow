import React, { useEffect, useMemo, useState } from 'react';
import Icon from './icon';
import { showValue } from './node-config';
import HeatmapWaterfall, { HeatmapSettingsButton } from './heatmap-waterfall';
import { heatmapFromSamples } from '../scripts/heatmap';

const statuses = { passed: 'In range', failed: 'Violation', unknown: 'Unknown' };
const escapeCsv = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
const display = sample => sample.display ?? showValue(sample.value);
const clip = text => (text.length > 75 ? `${text.slice(0, 72)}…` : text);

/** Bottom dock. Tab 1: heatmap of every variable over the whole run (like a
 * spectrum-analyzer waterfall). Tab 2: user-placed Watch node channels.
 * `run` = { hasRun, heatmap, samples, total, unit }. `cursor` is the playback
 * position on the same timeline as the heatmap. */
export default function WaterfallInspector({ run, cursor, isPlaying, collapsed, setCollapsed, onJump, onSeek, title = 'Execution Waterfall', className = '' }) {
  const [tab, setTab] = useState('heatmap');
  const [activeId, setActiveId] = useState(null);
  useEffect(() => { setActiveId(null); }, [run]);
  const total = Math.max(1, run?.total || 1);
  const position = cursor == null ? total : cursor;
  const samples = useMemo(() => (run?.samples || []).filter(s => s.step <= position), [run, position]);
  const watchModel = useMemo(() => heatmapFromSamples(run?.samples || [], total), [run, total]);
  const failures = samples.filter(s => s.state === 'failed' || s.state === 'unknown').length;
  const active = samples.find(s => s.id === activeId);
  const complete = Boolean(run?.hasRun && position >= total);
  const stateLabel = !run?.hasRun ? 'READY' : complete ? 'COMPLETE · HELD' : isPlaying ? 'CAPTURING LIVE' : 'PAUSED · HELD';
  const unit = run?.unit || 'step';

  const exportCsv = () => {
    const headers = ['Position', 'Watch node', 'Variable', 'Observed value', 'Type', 'State', 'Validation'];
    const rows = samples.map(s => [s.step, s.watchName, s.variable, display(s), s.dataType, s.state, s.reason || '']);
    const csv = [headers, ...rows].map(row => row.map(escapeCsv).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'nexa-flow-watchpoints.csv'; document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return <section className={`waterfall-dock ${collapsed ? 'is-collapsed' : ''} ${className}`} aria-label="Waterfall inspector">
    <header className="waterfall-header">
      <div className="waterfall-heading"><span className="waterfall-heading-icon"><Icon name="layers" size={17}/></span><div><strong>{title}</strong><small>Every variable over the whole run · Watch nodes in their own tab</small></div></div>
      <div className="waterfall-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'heatmap'} className={tab === 'heatmap' ? 'active' : ''} onClick={() => { setTab('heatmap'); if (collapsed) setCollapsed(false); }}>Heatmap{run?.heatmap?.rows.length ? <span>{run.heatmap.rows.length}</span> : null}</button>
        <button type="button" role="tab" aria-selected={tab === 'watch'} className={tab === 'watch' ? 'active' : ''} onClick={() => { setTab('watch'); if (collapsed) setCollapsed(false); }}>Watchpoints{watchModel.rows.length ? <span>{watchModel.rows.length}</span> : null}</button>
      </div>
      <div className="waterfall-meta" aria-live="polite"><span className={`waterfall-status ${isPlaying && !complete ? 'is-live' : ''}`}><span className="waterfall-status-dot"/>{stateLabel}</span>{failures > 0 && <span className="waterfall-count-fail">{failures} flagged</span>}{run?.hasRun && <span className="waterfall-progress">{Math.min(position, total).toLocaleString()}/{total.toLocaleString()} {unit}s</span>}</div>
      <div className="waterfall-header-actions"><HeatmapSettingsButton/>{tab === 'watch' && <button type="button" title="Export watchpoint samples as CSV" onClick={exportCsv} disabled={!samples.length}><Icon name="download" size={14}/><span>CSV</span></button>}<button type="button" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed} aria-label={collapsed ? 'Expand waterfall' : 'Collapse waterfall'} title={collapsed ? 'Expand waterfall' : 'Collapse waterfall'}><Icon name="chevronDown" size={16} className={collapsed ? '' : 'waterfall-chevron-open'}/></button></div>
    </header>
    {!collapsed && <div className="waterfall-body">
      {!run?.hasRun ? <div className="waterfall-empty"><Icon name="monitor" size={25}/><strong>Ready to observe data</strong><span>Press Run. The heatmap fills in with every variable as the program executes. Wire Watch nodes to functions to add focused watchpoints.</span></div>
        : tab === 'heatmap' ? <HeatmapWaterfall model={run.heatmap} cursor={position} onSeek={onSeek} unit={unit} emptyMessage="No variables were written during this run."/>
        : !watchModel.rows.length ? <div className="waterfall-empty"><Icon name="eye" size={25}/><strong>No watchpoints yet</strong><span>Add a Watch node and connect it: a function's <b>out</b> port → Watch shows return values, <b>DONE</b> → Watch shows completed calls, Watch → a function input shows that argument, and a Watch set to a named variable follows that local. Imported single functions have a <b>Value</b> port for the same purpose.</span></div>
        : <div className="waterfall-columns">
          <div className="waterfall-chart"><HeatmapWaterfall model={watchModel} cursor={position} onSeek={onSeek} unit={unit}/></div>
          <div className="waterfall-details"><div className="waterfall-details-title">WATCH SAMPLES <span>Newest last</span></div><div className="waterfall-events" role="log" aria-label="Recorded Watch samples">{samples.slice(-400).map(s => <button type="button" key={s.id} className={`waterfall-event ${s.state} ${activeId === s.id ? 'selected' : ''}`} onClick={() => { setActiveId(s.id); onJump?.(s.nodeId); onSeek?.(s.step - 1); }}><span className="waterfall-event-step">#{s.step}</span><span className="waterfall-event-main"><strong>{s.variable}</strong><small>{s.watchName}{s.sourceLine ? ` · line ${s.sourceLine}` : ''}</small></span><code title={display(s)}>{clip(display(s))}</code><span className="waterfall-event-dot" title={s.reason}/></button>)}</div>{active && <div className="waterfall-selected-detail"><strong>{active.watchName}: {active.variable}</strong><span>{active.dataType} · {statuses[active.state] || active.state}</span><code>{active.previousValue !== undefined && active.display == null ? `${showValue(active.previousValue)} → ` : ''}{display(active)}</code><small>{active.reason}</small></div>}</div>
        </div>}
    </div>}
  </section>;
}
