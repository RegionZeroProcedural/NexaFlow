import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { PALETTES, DEFAULT_HEATMAP_SETTINGS, paletteLut, paletteCss, rgbOf } from '../scripts/heatmap';

// ---------- Shared, persisted colour settings ----------
const SETTINGS_KEY = 'nexa-flow:heatmap:v1';
let currentSettings = (() => {
  try { return { ...DEFAULT_HEATMAP_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch (_) { return { ...DEFAULT_HEATMAP_SETTINGS }; }
})();
const listeners = new Set();
function setSharedSettings(patch) {
  currentSettings = { ...currentSettings, ...patch };
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(currentSettings)); } catch (_) { /* private mode */ }
  listeners.forEach(fn => fn());
}
export function useHeatmapSettings() {
  const settings = useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn); }, () => currentSettings);
  return [settings, setSharedSettings];
}

export function HeatmapSettingsButton() {
  const [settings, setSettings] = useHeatmapSettings();
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = e => { if (!root.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  return <div className="hm-settings" ref={root}>
    <button type="button" className="hm-settings-button" aria-expanded={open} title="Heatmap colours and scaling" onClick={() => setOpen(v => !v)}><span className="hm-settings-swatch" style={{ background: paletteCss(settings) }}/>Colours</button>
    {open && <div className="hm-settings-pop" role="dialog" aria-label="Heatmap settings">
      <h4>Colour map</h4>
      <div className="hm-palettes">{Object.entries(PALETTES).map(([id, p]) => <button type="button" key={id} className={settings.palette === id ? 'active' : ''} onClick={() => setSettings({ palette: id })}><span style={{ background: paletteCss({ ...settings, palette: id }) }}/>{p.name}</button>)}</div>
      {settings.palette === 'custom' && <div className="hm-custom">
        {['Low', 'Mid', 'High'].map((label, i) => <label key={label}>{label}<input type="color" value={settings.custom[i]} onChange={e => { const custom = [...settings.custom]; custom[i] = e.target.value; setSettings({ custom }); }}/></label>)}
      </div>}
      <label className="hm-row-setting">No value yet<input type="color" value={settings.empty} onChange={e => setSettings({ empty: e.target.value })}/></label>
      <h4>Colour by</h4>
      <div className="hm-toggle">
        <button type="button" className={settings.mode === 'value' ? 'active' : ''} onClick={() => setSettings({ mode: 'value' })} title="Each row is normalised between its own min and max">Value</button>
        <button type="button" className={settings.mode === 'activity' ? 'active' : ''} onClick={() => setSettings({ mode: 'activity' })} title="Bright when the variable was just written, fading afterwards">Write activity</button>
      </div>
      <h4>Scale</h4>
      <div className="hm-toggle">
        <button type="button" className={settings.scale === 'linear' ? 'active' : ''} onClick={() => setSettings({ scale: 'linear' })}>Linear</button>
        <button type="button" className={settings.scale === 'log' ? 'active' : ''} onClick={() => setSettings({ scale: 'log' })}>Log</button>
      </div>
      <button type="button" className="hm-reset" onClick={() => setSettings({ ...DEFAULT_HEATMAP_SETTINGS })}>Reset to defaults</button>
    </div>}
  </div>;
}

// ---------- Renderer ----------
const RULER = 18;
const niceStep = raw => { const p = 10 ** Math.floor(Math.log10(Math.max(1e-9, raw))); const m = raw / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; };
const logish = x => Math.sign(x) * Math.log1p(Math.abs(x));
function valueAt(row, t) {
  const c = row.changes;
  let lo = 0, hi = c.length - 1, found = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (c[mid].t <= t) { found = mid; lo = mid + 1; } else hi = mid - 1; }
  return found < 0 ? null : c[found];
}

/** Rows = variables (labelled on the left), x = execution timeline. */
export default function HeatmapWaterfall({ model, cursor = null, onSeek, emptyMessage = 'No values recorded yet.', unit = 'step' }) {
  const [settings] = useHeatmapSettings();
  const [filter, setFilter] = useState('');
  const [zoom, setZoom] = useState(null); // px per timeline unit; null = fit
  const [offset, setOffset] = useState(0);
  const [rowH, setRowH] = useState(16);
  const [scrollTop, setScrollTop] = useState(0);
  const [size, setSize] = useState({ w: 600, h: 160 });
  const [hover, setHover] = useState(null);
  const plotRef = useRef(null), canvasRef = useRef(null), offRef = useRef(null), drag = useRef(null);
  const lut = useMemo(() => paletteLut(settings), [settings]);
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (model?.rows || []).filter(r => !q || `${r.group} ${r.label}`.toLowerCase().includes(q));
  }, [model, filter]);
  const length = Math.max(1, model?.length || 1);
  const fitZoom = size.w / length;
  const z = zoom ?? fitZoom;
  const off = zoom == null ? 0 : offset;
  const contentH = rows.length * rowH;
  const maxScroll = Math.max(0, contentH - (size.h - RULER));
  const top = Math.min(scrollTop, maxScroll);

  useEffect(() => {
    const el = plotRef.current; if (!el) return undefined;
    const ro = new ResizeObserver(([entry]) => setSize({ w: Math.max(50, Math.floor(entry.contentRect.width)), h: Math.max(40, Math.floor(entry.contentRect.height)) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { setZoom(null); setOffset(0); }, [model?.length]);

  const clampView = useCallback((nz, no) => {
    const minZ = Math.min(fitZoom, 1), maxZ = 60;
    const zz = Math.max(minZ, Math.min(maxZ, nz));
    const visible = size.w / zz;
    const oo = Math.max(0, Math.min(Math.max(0, length - visible), no));
    if (zz <= fitZoom + 1e-9) { setZoom(null); setOffset(0); return; }
    setZoom(zz); setOffset(oo);
  }, [fitZoom, size.w, length]);
  const zoomAt = useCallback((factor, px) => { const t = off + px / z; const nz = z * factor; clampView(nz, t - px / nz); }, [off, z, clampView]);

  // Draw
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.w * dpr; canvas.height = size.h * dpr;
    canvas.style.width = `${size.w}px`; canvas.style.height = `${size.h}px`;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const empty = rgbOf(settings.empty);
    ctx.fillStyle = settings.empty; ctx.fillRect(0, 0, size.w, size.h);
    const first = Math.floor(top / rowH), last = Math.min(rows.length, Math.ceil((top + size.h - RULER) / rowH));
    const count = Math.max(0, last - first);
    if (count && size.w) {
      const off2 = offRef.current || (offRef.current = document.createElement('canvas'));
      off2.width = size.w; off2.height = count;
      const octx = off2.getContext('2d');
      const img = octx.createImageData(size.w, count);
      const data = img.data;
      const tau = Math.max(2, 10 / z);
      for (let r = 0; r < count; r++) {
        const row = rows[first + r];
        const log = settings.scale === 'log';
        const mn = log ? logish(row.min) : row.min, mx = log ? logish(row.max) : row.max;
        const span = mx - mn;
        const changes = row.changes;
        let j = -1;
        for (let x = 0; x < size.w; x++) {
          const t = Math.floor(off + x / z);
          while (j + 1 < changes.length && changes[j + 1].t <= t) j++;
          const p = (r * size.w + x) * 4;
          const c = j >= 0 ? changes[j] : null;
          let q = null;
          if (c && t < length) {
            if (settings.mode === 'activity') q = Math.exp(-(t - c.t) / tau);
            else if (typeof c.x === 'number') { const xv = log ? logish(c.x) : c.x; q = span > 0 ? (xv - mn) / span : 0.22; } // constant rows stay dim so changes stand out
          }
          if (q === null) { data[p] = empty[0]; data[p + 1] = empty[1]; data[p + 2] = empty[2]; data[p + 3] = 255; continue; }
          const k = Math.max(0, Math.min(255, Math.round(q * 255))) * 3;
          data[p] = lut[k]; data[p + 1] = lut[k + 1]; data[p + 2] = lut[k + 2]; data[p + 3] = 255;
        }
      }
      octx.putImageData(img, 0, 0);
      ctx.save();
      ctx.beginPath(); ctx.rect(0, RULER, size.w, size.h - RULER); ctx.clip();
      ctx.imageSmoothingEnabled = false;
      const y0 = RULER + first * rowH - top;
      ctx.drawImage(off2, 0, 0, size.w, count, 0, y0, size.w, count * rowH);
      // change ticks, flags and row separators
      for (let r = 0; r < count; r++) {
        const row = rows[first + r], y = y0 + r * rowH;
        if (rowH >= 9) { ctx.fillStyle = '#00000055'; ctx.fillRect(0, y + rowH - 1, size.w, 1); }
        for (const c of row.changes) {
          const x = (c.t - off) * z;
          if (x < -2 || x > size.w) continue;
          if (c.flag) { ctx.fillStyle = '#ff4d6d'; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + Math.min(rowH, 7)); ctx.fill(); }
          else if (z >= 4 && rowH >= 9) { ctx.fillStyle = '#ffffff40'; ctx.fillRect(x, y, 1, rowH - 1); }
        }
      }
      // not-yet-reached part of the run
      if (cursor != null && cursor < length) {
        const cx = Math.max(0, (cursor - off) * z);
        ctx.fillStyle = '#05060dcc'; ctx.fillRect(cx, RULER, size.w - cx, size.h - RULER);
      }
      ctx.restore();
    }
    // ruler
    ctx.fillStyle = '#141827'; ctx.fillRect(0, 0, size.w, RULER);
    ctx.fillStyle = '#8b93b8'; ctx.font = '10px ui-monospace, Consolas, monospace';
    const step = niceStep(80 / z);
    for (let t = Math.ceil(off / step) * step; t <= off + size.w / z; t += step) {
      const x = (t - off) * z;
      ctx.fillRect(x, RULER - 5, 1, 5);
      ctx.fillText(String(t), x + 3, 12);
    }
    if (cursor != null) {
      const cx = (cursor - off) * z;
      if (cx >= 0 && cx <= size.w) { ctx.fillStyle = '#ffd27a'; ctx.fillRect(cx - 1, 0, 2, size.h); }
    }
  }, [rows, size, z, off, rowH, top, settings, lut, cursor, length]);

  const locate = e => {
    const rect = plotRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const t = Math.floor(off + x / z);
    const r = y < RULER ? -1 : Math.floor((y - RULER + top) / rowH);
    return { x, y, t, row: rows[r] || null };
  };
  const onWheel = e => {
    const rect = plotRef.current.getBoundingClientRect();
    if (e.ctrlKey) setRowH(h => Math.max(3, Math.min(48, Math.round(h * (e.deltaY < 0 ? 1.15 : 0.87)))));
    else if (e.shiftKey) setScrollTop(s => Math.max(0, Math.min(maxScroll, s + e.deltaY)));
    else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) clampView(z, off + e.deltaX / z);
    else zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left);
  };
  useEffect(() => {
    const el = plotRef.current; if (!el) return undefined;
    const block = e => e.preventDefault();
    el.addEventListener('wheel', block, { passive: false });
    return () => el.removeEventListener('wheel', block);
  }, []);
  useEffect(() => {
    const move = e => {
      const d = drag.current; if (!d) return;
      if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) d.moved = true;
      if (d.moved) { clampView(d.z, d.off - (e.clientX - d.x) / d.z); setScrollTop(Math.max(0, Math.min(maxScroll, d.top - (e.clientY - d.y)))); }
    };
    const up = e => { const d = drag.current; drag.current = null; if (d && !d.moved && onSeek && plotRef.current?.contains(e.target)) { const hit = locate(e); if (hit.t >= 0 && hit.t < length) onSeek(hit.t); } };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  });

  const hoverValue = hover?.row ? valueAt(hover.row, hover.t) : null;
  if (!model || !model.rows.length) return <div className="hm-empty">{emptyMessage}</div>;
  return <div className="hm">
    <div className="hm-toolbar">
      <input className="hm-filter" placeholder="Filter variables…" value={filter} onChange={e => setFilter(e.target.value)} aria-label="Filter heatmap rows"/>
      <span className="hm-group-label">Time</span>
      <button type="button" title="Zoom out (scroll down on the plot)" onClick={() => zoomAt(1 / 1.6, size.w / 2)}>−</button>
      <button type="button" title="Zoom in (scroll up on the plot)" onClick={() => zoomAt(1.6, cursor != null ? (cursor - off) * z : size.w / 2)}>+</button>
      <button type="button" title="Fit the whole run" onClick={() => { setZoom(null); setOffset(0); }}>Fit</button>
      <span className="hm-group-label">Rows</span>
      <button type="button" title="Shorter rows (Ctrl + scroll)" onClick={() => setRowH(h => Math.max(3, h - 3))}>−</button>
      <button type="button" title="Taller rows (Ctrl + scroll)" onClick={() => setRowH(h => Math.min(48, h + 3))}>+</button>
      <span className="hm-legend"><span>{settings.mode === 'activity' ? 'idle' : 'low'}</span><i style={{ background: paletteCss(settings) }}/><span>{settings.mode === 'activity' ? 'just written' : 'high'}</span></span>
      <span className="hm-count">{rows.length} rows · {length.toLocaleString()} {unit}s</span>
    </div>
    <div className="hm-main">
      <div className="hm-labels" style={{ '--row-h': `${rowH}px` }} onWheel={e => setScrollTop(st => Math.max(0, Math.min(maxScroll, st + e.deltaY)))}>
        <div className="hm-labels-head">VARIABLE</div>
        <div className="hm-labels-clip"><div style={{ transform: `translateY(${-top}px)` }}>{rows.map(row => <div key={row.id} className={`hm-label ${hover?.row === row ? 'hover' : ''}`} style={{ height: rowH }} title={`${row.group} › ${row.label}${row.numeric ? ` · range ${row.min} … ${row.max}` : row.distinct != null ? ` · ${row.distinct} distinct values` : ''}`}>{rowH >= 11 && <small>{row.group}</small>}<span>{row.label}</span></div>)}</div></div>
      </div>
      <div className="hm-plot" ref={plotRef}
        onWheel={onWheel}
        onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); drag.current = { x: e.clientX, y: e.clientY, z, off, top, moved: false }; }}
        onPointerMove={e => setHover(locate(e))} onPointerLeave={() => setHover(null)}>
        <canvas ref={canvasRef}/>
        {hover?.row && <div className="hm-tip" style={{ left: Math.min(hover.x + 14, size.w - 230), top: Math.min(hover.y + 12, size.h - 54) }}>
          <strong>{hover.row.group} › {hover.row.label}</strong>
          <span>{unit} {hover.t}</span>
          <code>{hoverValue ? hoverValue.v?.s : 'not set yet'}</code>
          {hoverValue?.flag && <em>⚠ {hoverValue.sample?.reason}</em>}
        </div>}
      </div>
    </div>
  </div>;
}
