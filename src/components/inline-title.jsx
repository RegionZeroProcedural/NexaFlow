import React, { useEffect, useRef, useState } from 'react';

/**
 * Inline title field shared by graph and node headings.
 * The button can receive keyboard focus and never initiates a canvas drag.
 * Enter / blur commits, Escape restores the original name. Empty names are
 * ignored. No graph history or autosave writes are generated per keystroke.
 */
export default function InlineTitle({ value = '', onCommit, className = '', label = 'title', maxLength = 80 }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || '');
  const inputRef = useRef(null);
  const cancelRef = useRef(false);

  useEffect(() => { if (!editing) setDraft(value || ''); }, [value, editing]);
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const begin = event => {
    event.stopPropagation();
    cancelRef.current = false;
    setDraft(value || '');
    setEditing(true);
  };
  const finish = () => {
    if (!cancelRef.current) {
      const next = draft.trim();
      if (next && next !== value) onCommit(next);
    }
    cancelRef.current = false;
    setEditing(false);
  };
  const stopPointer = event => event.stopPropagation();
  const stopDoubleClick = event => event.stopPropagation();

  if (editing) return <input
    ref={inputRef}
    type="text"
    className={`${className} inline-title-input`}
    aria-label={`Edit ${label}`}
    maxLength={maxLength}
    spellCheck={false}
    value={draft}
    onChange={event => setDraft(event.target.value)}
    onBlur={finish}
    onPointerDown={stopPointer}
    onClick={stopPointer}
    onDoubleClick={stopDoubleClick}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        cancelRef.current = true;
        event.currentTarget.blur();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        event.currentTarget.blur();
      }
    }}
  />;

  return <button
    type="button"
    className={`${className} inline-title-trigger`}
    title={`Click to rename ${label}`}
    aria-label={`Rename ${label}: ${value || 'Untitled'}`}
    onPointerDown={stopPointer}
    onClick={begin}
    onDoubleClick={stopDoubleClick}
  >{value || 'Untitled'}</button>;
}
