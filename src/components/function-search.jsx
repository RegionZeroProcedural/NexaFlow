import React, { useEffect, useMemo, useRef, useState } from 'react';
import { searchFunctions } from '../scripts/microscope/project-index';

/** Function-name search across the imported project. Enter opens the
 * highlighted result in the microscope; Ctrl+K or "/" focuses the field. */
export default function FunctionSearch({ project, onOpen, onShowOnBoard, compact = false, placeholder = 'Search functions…  (Ctrl+K)' }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef(null);
  const root = useRef(null);
  const results = useMemo(() => searchFunctions(project, query, 40), [project, query]);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    const key = e => {
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
      if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') || (e.key === '/' && !typing)) {
        if (!root.current?.offsetParent) return; // hidden instance
        e.preventDefault(); input.current?.focus(); setOpen(true);
      }
    };
    const away = e => { if (!root.current?.contains(e.target)) setOpen(false); };
    window.addEventListener('keydown', key);
    document.addEventListener('pointerdown', away);
    return () => { window.removeEventListener('keydown', key); document.removeEventListener('pointerdown', away); };
  }, []);
  if (!project) return null;
  const choose = fn => { setOpen(false); setQuery(''); input.current?.blur(); onOpen(fn.id); };
  return <div className={`function-search ${compact ? 'compact' : ''}`} ref={root} onPointerDown={e => e.stopPropagation()}>
    <span className="function-search-icon" aria-hidden="true">⌕</span>
    <input ref={input} value={query} placeholder={placeholder} aria-label="Search function names" spellCheck="false"
      onFocus={() => setOpen(true)} onChange={e => { setQuery(e.target.value); setOpen(true); }}
      onKeyDown={e => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(results.length - 1, i + 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(0, i - 1)); }
        else if (e.key === 'Enter' && results[active]) { e.preventDefault(); choose(results[active]); }
        else if (e.key === 'Escape') { setOpen(false); input.current?.blur(); }
      }}/>
    {open && <div className="function-search-results" role="listbox">
      {!query && <div className="function-search-hint">Likely entry points first · {project.stats.functions} functions in {project.stats.files} files</div>}
      {results.length ? results.map((fn, i) => <div key={fn.id} role="option" aria-selected={i === active} className={`function-search-item ${i === active ? 'active' : ''}`} onMouseEnter={() => setActive(i)} onMouseDown={e => { e.preventDefault(); choose(fn); }}>
        <div className="function-search-name"><strong>{fn.name}</strong><span>({fn.params.join(', ')})</span>{project.rootId === fn.id && <em className="entry-badge">ENTRY</em>}{fn.async && <em>async</em>}</div>
        <small>{fn.path}:{fn.line} · {fn.kind}{fn.parentId ? ' · nested' : ''} · {fn.calls.length} calls · {fn.callers.length} callers</small>
        {onShowOnBoard && <button type="button" className="function-search-board" title="Show on call board" onMouseDown={e => { e.preventDefault(); e.stopPropagation(); setOpen(false); onShowOnBoard(fn.id); }}>board</button>}
      </div>) : <div className="function-search-hint">No function matches “{query}”.</div>}
    </div>}
  </div>;
}
