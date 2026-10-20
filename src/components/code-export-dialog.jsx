import React, { useEffect, useMemo, useState } from 'react';
import { EXPORT_LANGUAGES, generateCode } from '../scripts/generate-code';
import { exportImportedJavaScript } from '../scripts/javascript-import';

export default function CodeExportDialog({ graph, close, download }) {
  const [language, setLanguage] = useState('javascript');
  const result = useMemo(() => { try { return { code: graph.program?.kind === 'javascript-function' ? (language === 'javascript' ? exportImportedJavaScript(graph) : (() => { throw new Error('Imported sources round-trip to JavaScript only in v0.4. Cross-language conversion is not safe for arbitrary imported source.'); })()) : generateCode(graph, language), error: '' }; } catch (e) { return { code: '', error: e.message }; } }, [graph, language]);
  const { code, error } = result;
  useEffect(() => { const onKey = e => { if (e.key === 'Escape') close(); }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, [close]);
  const format = EXPORT_LANGUAGES.find(lang => lang.id === language);
  return <div className="code-export-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) close(); }} role="presentation">
    <section className="code-export-dialog" role="dialog" aria-modal="true" aria-labelledby="code-export-title">
      <div className="code-export-header"><div><small>CODE GENERATION</small><h2 id="code-export-title">Export flow skeleton</h2></div><button type="button" aria-label="Close exporter" onClick={close}>×</button></div>
      <p>{graph.program ? 'Lossless JavaScript source patching: only supported, edited expressions are replaced. Unsupported code, imports and comments are preserved unchanged. Rewired or added nodes cannot be exported to source yet.' : 'Export callable Function definitions with typed connections and supported expressions. Process actions remain TODOs; arbitrary source translation is not supported.'}</p>
      <label>Target language <select value={language} onChange={e => setLanguage(e.target.value)}>{EXPORT_LANGUAGES.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
      {error && <div className="node-code-status error" role="alert">Cannot export: {error}. Correct the Function body first.</div>}
      <textarea aria-label="Generated code preview" className="generated-code" value={code} readOnly spellCheck="false"/>
      <div className="code-export-actions"><small>{code.split('\n').length} lines · {format.name}</small><button type="button" disabled={Boolean(error)} onClick={() => { navigator.clipboard?.writeText(code).catch(() => {}); }}>Copy</button><button type="button" className="primary-button" disabled={Boolean(error)} onClick={() => download(code, format.extension)}>Download .{format.extension}</button></div>
    </section>
  </div>;
}
