import React, { useEffect, useMemo, useRef, useState } from 'react';
import Icon from './icon';
import { showValue } from './node-config';
import { visibleWaterfallSamples } from '../scripts/waterfall';

const clipValue = value => {
  const display = showValue(value);
  return display.length > 75 ? `${display.slice(0, 72)}…` : display;
};
const statuses = { passed: 'In range', failed: 'Violation', unknown: 'Unknown' };
const escapeCsv = value => `"${String(value ?? '').replace(/"/g, '""')}"`;

/** Bottom dock is deliberately run-scoped, not tied to the Inspector's selection.
 * A user may rewind or edit the flow without losing what was already captured. */
export default function WaterfallInspector({ run, revealedStep, isPlaying, collapsed, setCollapsed, onJump }) {
  const [activeId, setActiveId] = useState(null);
  const scrollRef = useRef(null);
  const samples = useMemo(() => visibleWaterfallSamples(run?.samples || [], revealedStep), [run, revealedStep]);
  const lanes = useMemo(() => {
    const result = new Map();
    for (const sample of samples) {
      const key = sample.watchId || sample.nodeId || sample.watchName;
      if (!result.has(key)) result.set(key, { key, label: sample.watchName, samples: [] });
      result.get(key).samples.push(sample);
    }
    return [...result.values()];
  }, [samples]);
  const failures = samples.filter(sample => sample.state === 'failed' || sample.state === 'unknown').length;
  const active = samples.find(sample => sample.id === activeId);
  const totalSteps = Math.max(1, run?.total || 1);
  const complete = Boolean(run?.hasRun && revealedStep >= (run.total || 0));
  const stateLabel = !run?.hasRun ? 'READY' : complete ? 'COMPLETE · HELD' : isPlaying ? 'CAPTURING LIVE' : 'PAUSED · HELD';
  useEffect(() => { setActiveId(null); }, [run]);
  useEffect(() => {
    if (scrollRef.current && isPlaying) scrollRef.current.scrollLeft = Math.max(0, (revealedStep - 8) * 48);
  }, [revealedStep, isPlaying]);

  const exportCsv = () => {
    const headers = ['Playback step', 'Watch node', 'Variable', 'Port', 'Previous value', 'Observed value', 'Type', 'State', 'Validation', 'Source line'];
    const rows = samples.map(sample => [sample.step, sample.watchName, sample.variable, sample.port || '', showValue(sample.previousValue), showValue(sample.value), sample.dataType, sample.state, sample.reason || '', sample.sourceLine || '']);
    const csv = [headers, ...rows].map(row => row.map(escapeCsv).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'nexa-flow-watch-waterfall.csv'; document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return <section className={`waterfall-dock ${collapsed ? 'is-collapsed' : ''}`} aria-label="Watch waterfall inspector">
    <header className="waterfall-header">
      <div className="waterfall-heading"><span className="waterfall-heading-icon"><Icon name="layers" size={17}/></span><div><strong>Watch Waterfall</strong><small>Variable values &amp; validation across simulation steps</small></div></div>
      <div className="waterfall-meta" aria-live="polite"><span className={`waterfall-status ${isPlaying && !complete ? 'is-live' : ''}`}><span className="waterfall-status-dot"/>{stateLabel}</span><span>{samples.length} capture{samples.length === 1 ? '' : 's'}</span>{failures > 0 && <span className="waterfall-count-fail">{failures} flagged</span>}{run?.hasRun && <span className="waterfall-progress">{Math.min(revealedStep, run.total)}/{run.total} steps</span>}</div>
      <div className="waterfall-header-actions"><button type="button" title="Export captured samples as CSV" onClick={exportCsv} disabled={!samples.length}><Icon name="download" size={14}/><span>CSV</span></button><button type="button" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed} aria-label={collapsed ? 'Expand waterfall inspector' : 'Collapse waterfall inspector'} title={collapsed ? 'Expand waterfall inspector' : 'Collapse waterfall inspector'}><Icon name="chevronDown" size={16} className={collapsed ? '' : 'waterfall-chevron-open'}/></button></div>
    </header>
    {!collapsed && <div className="waterfall-body">
      {!run?.hasRun ? <div className="waterfall-empty"><Icon name="monitor" size={25}/><strong>Ready to observe data</strong><span>Wire a Variable or Function output into a Watch node, then press Run. For imported JavaScript, add a watch rule in Forensics.</span></div>
        : !samples.length ? <div className="waterfall-empty"><Icon name="eye" size={25}/><strong>{isPlaying ? 'Waiting for Watch observations…' : 'No observations captured'}</strong><span>Only connected Watch nodes and imported-source watch rules generate waterfall readings. Each reading appears when its simulated step is reached.</span></div>
        : <div className="waterfall-columns">
          <div className="waterfall-chart"><div className="waterfall-chart-title"><span>WATCH CHANNELS</span><span>STEP TIMELINE <i className="waterfall-key passed"/> pass <i className="waterfall-key failed"/> flagged</span></div>
            <div className="waterfall-chart-layout"><div className="waterfall-lane-names"><div className="waterfall-ruler-spacer">WATCH NODE</div>{lanes.map(lane => <div key={lane.key} className="waterfall-lane-name" title={lane.label}>{lane.label}</div>)}</div>
              <div className="waterfall-chart-scroll" ref={scrollRef} aria-label="Watch event timeline" tabIndex={0}><div className="waterfall-track" style={{ '--waterfall-step-count': totalSteps }}><div className="waterfall-ticks" style={{ gridTemplateColumns: `repeat(${totalSteps}, 48px)` }}>{Array.from({ length: totalSteps }, (_, i) => <span key={i} className={revealedStep === i + 1 ? 'is-current' : ''}>{i + 1}</span>)}</div>{lanes.map(lane => <div className="waterfall-track-row" style={{ gridTemplateColumns: `repeat(${totalSteps}, 48px)` }} key={lane.key}>{lane.samples.map(sample => <button type="button" className={`waterfall-point ${sample.state} ${activeId === sample.id ? 'selected' : ''}`} key={sample.id} style={{ gridColumn: sample.step }} title={`Step ${sample.step} · ${sample.variable} = ${showValue(sample.value)} · ${statuses[sample.state] || sample.state}`} aria-label={`${sample.watchName} at step ${sample.step}: ${showValue(sample.value)} (${sample.state})`} onClick={() => { setActiveId(sample.id); onJump?.(sample.nodeId); }}><span/></button>)}</div>)}</div></div>
            </div><div className="waterfall-timeline-footnote">Horizontal position is simulation order, not elapsed CPU time. Values are from the restricted interpreter, never from arbitrary source execution.</div>
          </div>
          <div className="waterfall-details"><div className="waterfall-details-title">OBSERVED VALUES <span>Newest last</span></div><div className="waterfall-events" role="log" aria-label="Recorded Watch samples">{samples.map(sample => <button type="button" key={sample.id} className={`waterfall-event ${sample.state} ${activeId === sample.id ? 'selected' : ''}`} onClick={() => { setActiveId(sample.id); onJump?.(sample.nodeId); }}><span className="waterfall-event-step">#{sample.step}</span><span className="waterfall-event-main"><strong>{sample.variable}</strong><small>{sample.watchName}{sample.sourceLine ? ` · line ${sample.sourceLine}` : ''}</small></span><code title={showValue(sample.value)}>{clipValue(sample.value)}</code><span className="waterfall-event-dot" title={sample.reason}/></button>)}</div>{active && <div className="waterfall-selected-detail"><strong>{active.watchName}: {active.variable}</strong><span>{active.dataType} · {statuses[active.state] || active.state}</span><code>{showValue(active.previousValue)} → {showValue(active.value)}</code><small>{active.reason}</small></div>}</div>
        </div>}
    </div>}
  </section>;
}
