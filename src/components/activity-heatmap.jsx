import React, { useMemo } from 'react';
import HeatmapWaterfall, { createSettingsStore } from './heatmap-waterfall';
import { ACTIVITY_WINDOWS, DEFAULT_ACTIVITY_SETTINGS, buildActivityModel, activitySampler, activityStats, sortByActivity } from '../scripts/heatmap';

// Independent of the Value Heatmap's settings; only the colour map is shared.
export const useActivitySettings = createSettingsStore('nexa-flow:activity-heatmap:v1', DEFAULT_ACTIVITY_SETTINGS);

/** How often each variable changes, as a spectrum-analyzer waterfall.
 * `model` is the run's value heatmap model; change detection runs once per
 * model, and playback only moves the `cursor`/`revealed` positions. */
export default function ActivityHeatmap({ model, cursor = null, revealed = null, onSeek, unit = 'step' }) {
  const [settings, setSettings] = useActivitySettings();
  const activity = useMemo(() => buildActivityModel(model), [model]);
  // Everything up to the furthest playback position counts as observed, so
  // statistics and sort order hold steady while rewinding.
  const seen = revealed == null ? cursor : Math.max(revealed, cursor ?? 0);
  const upTo = seen == null ? Infinity : seen - 1;
  const w = ACTIVITY_WINDOWS.includes(settings.window) ? settings.window : DEFAULT_ACTIVITY_SETTINGS.window;
  const effective = useMemo(() => ({ ...settings, window: w }), [settings, w]);
  const stats = useMemo(() => activityStats(activity, w, upTo), [activity, w, upTo]);
  const sampler = useMemo(() => activitySampler(activity, effective, seen), [activity, effective, seen]);
  const view = useMemo(() => ({ length: activity.length, rows: settings.sort === 'activity' ? sortByActivity(activity.rows, upTo) : activity.rows }), [activity, settings.sort, upTo]);
  const name = row => `${row.group} › ${row.label}`;

  const controls = <>
    <span className="hm-group-label">Window</span>
    <select className="hm-select" value={w} onChange={e => setSettings({ window: Number(e.target.value) })} aria-label="Activity window size" title="Changes are counted inside this rolling window">
      {ACTIVITY_WINDOWS.map(size => <option key={size} value={size}>{size} {unit}{size === 1 ? '' : 's'}</option>)}
    </select>
    <select className="hm-select" value={settings.normalize} onChange={e => setSettings({ normalize: e.target.value })} aria-label="Activity normalisation" title="Peak: brightest = busiest window in this run. Absolute: brightest = a change on every step.">
      <option value="peak">Scale to run peak</option>
      <option value="absolute">Absolute (per step)</option>
    </select>
    <select className="hm-select" value={settings.sort} onChange={e => setSettings({ sort: e.target.value })} aria-label="Row order">
      <option value="activity">Most active first</option>
      <option value="order">Execution order</option>
    </select>
    <label className="hm-check" title="Blend in the two previous windows so bursts fade gradually. Never adds change events."><input type="checkbox" checked={settings.smoothing} onChange={e => setSettings({ smoothing: e.target.checked })}/> Smooth</label>
  </>;

  return <div className="activity-heatmap">
    <div className="activity-summary" aria-live="polite">
      <span><b>{stats.totalChanges.toLocaleString()}</b> changes detected</span>
      <span>Most active: {stats.mostActive ? <><b>{name(stats.mostActive.row)}</b> ({stats.mostActive.count})</> : '—'}</span>
      <span>Peak window: {stats.peak ? <><b>{name(stats.peak.row)}</b> {stats.peak.count}/{w} {unit}{w === 1 ? '' : 's'} ending at {stats.peak.t}</> : '—'}</span>
      <span><b>{stats.activeRows}</b> of {stats.observedRows} observed variable{stats.observedRows === 1 ? '' : 's'} changing</span>
    </div>
    <HeatmapWaterfall model={view} cursor={cursor} revealed={revealed} onSeek={onSeek} sampler={sampler} toolbarExtra={controls} unit={unit} emptyMessage="No variables were written during this run."/>
  </div>;
}
