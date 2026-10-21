import React, { useEffect } from 'react';

/** Asks for the project's source root before indexing every function. */
export default function ProjectImportDialog({ close, onChooseFolder, busy, progress, error }) {
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape' && !busy) close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, busy]);
  return <div className="code-export-backdrop" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget && !busy) close(); }}>
    <section className="code-export-dialog project-import-dialog" role="dialog" aria-modal="true" aria-labelledby="project-import-title">
      <div className="code-export-header"><div><small>FUNCTION MICROSCOPE · WHOLE-PROJECT IMPORT</small><h2 id="project-import-title">Import your source folder</h2></div><button type="button" aria-label="Close" onClick={close} disabled={busy}>×</button></div>
      <p>Choose the <strong>root of your <code>src</code> folder</strong>, or at least the folder that contains <strong>every file the function you care about depends on</strong>. Calls into files outside the chosen folder can't be followed and will show up as external.</p>
      <ul className="project-import-points">
        <li>Every function becomes a <strong>Function node</strong> on the call board. Click one to put it <strong>under the microscope</strong>.</li>
        <li>The microscope opens on the highest-level function it finds (<code>main()</code>, the function called at the top of your entry file, or <code>&lt;App/&gt;</code>).</li>
        <li>Reads <code>.js .jsx .mjs .cjs .ts .tsx</code>. Skips <code>node_modules</code>, <code>dist</code>, <code>build</code>, <code>.git</code> and <code>coverage</code>. Up to 800 files / 16 MB.</li>
        <li>Your files are read locally in the browser and never uploaded. Code runs only inside a step-by-step sandboxed interpreter, never natively.</li>
      </ul>
      {error && <p className="source-import-warning">{error}</p>}
      {busy && <p className="project-import-progress">{progress || 'Reading files…'}</p>}
      <div className="code-export-actions"><button type="button" onClick={close} disabled={busy}>Cancel</button><button type="button" className="primary-button" disabled={busy} onClick={onChooseFolder}>{busy ? 'Indexing…' : 'Choose src folder…'}</button></div>
    </section>
  </div>;
}
