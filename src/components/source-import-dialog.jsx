import React, { useEffect, useState } from 'react';

/** Import only selected source into the microscope; dependency functions stay
 * collapsed as safe, linked call nodes even across separate uploaded files. */
export default function SourceImportDialog({ draft, close, onImport }) {
  const [path, setPath] = useState(draft.first);
  const options = draft.optionsByFile[path] || [];
  const [selected, setSelected] = useState(() => draft.optionsByFile[draft.first]?.find(f => f.supportedBody && f.simpleParameters && f.parameters.length <= 16)?.index ?? 0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onKey = event => { if (event.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);
  const current = options.find(f => f.index === selected);
  const files = Object.keys(draft.workspace.files);
  const updatePath = chosen => { setPath(chosen); setSelected(draft.optionsByFile[chosen]?.find(f => f.supportedBody && f.simpleParameters && f.parameters.length <= 16)?.index ?? 0); };
  return <div className="code-export-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) close(); }} role="presentation">
    <section className="code-export-dialog source-import-dialog" role="dialog" aria-modal="true" aria-labelledby="source-import-title">
      <div className="code-export-header"><div><small>ISOLATED SOURCE MICROSCOPE · NOTHING EXECUTES</small><h2 id="source-import-title">Inspect a JavaScript function</h2></div><button type="button" aria-label="Close importer" onClick={close}>×</button></div>
      <p>Loaded <strong>{files.length} source file{files.length === 1 ? '' : 's'}</strong>. Choose an entry file and one function to expand. Expression-bodied arrow functions are supported; braces are not required. Helpers called by that function become <strong>compact Function Dependency nodes</strong>, including helpers in other selected files.</p>
      <label className="field-label">Entry source file<select value={path} onChange={e => updatePath(e.target.value)}>{files.map(name => <option key={name} value={name}>{name}</option>)}</select></label>
      <div className="source-function-options" aria-label="Choose a function">
        {options.length ? options.map(fn => <label key={fn.index} className={`source-function-choice ${selected === fn.index ? 'selected' : ''}`}>
          <input type="radio" name="source-function" checked={selected === fn.index} onChange={() => setSelected(fn.index)}/>
          <span><strong>{fn.name}({fn.parameters.join(', ')})</strong><small>Lines {fn.line}–{fn.endLine} · {fn.kind} · {fn.bodyStyle === 'expression' ? 'implicit return' : 'block body'}{fn.simpleParameters && fn.parameters.length <= 16 ? '' : ' · requires ≤16 simple parameters'}</small></span>
        </label>) : <p>No supported top-level functions in this file.</p>}
      </div>
      <p className="source-import-warning">Relative ES module imports resolve only against the files you selected. If another file is missing, its call remains unverified. Pure supported helpers can be interpreted through a limited IR; arbitrary JavaScript, network, filesystem, class methods, loops and side effects are NEVER executed. Save/export changes only to the focused source file.</p>
      <div className="code-export-actions"><button type="button" onClick={close}>Cancel</button><button type="button" className="primary-button" disabled={busy || !current?.supportedBody || !current?.simpleParameters || current.parameters.length > 16} onClick={() => { setBusy(true); try { onImport(path, selected); } finally { setBusy(false); } }}>Import focused function</button></div>
    </section>
  </div>;
}
