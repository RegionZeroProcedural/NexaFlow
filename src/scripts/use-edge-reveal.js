import { useCallback, useEffect, useRef, useState } from 'react';

/** Slide-out toolbar behaviour: stays hidden until the pointer hovers the
 * visible tab, then stays open until the pointer moves more than `distance`
 * pixels away from the toolbar (or its tab). Pinning keeps it open. */
export default function useEdgeReveal(pinned = false, distance = 15) {
  const toolbarRef = useRef(null);
  const tabRef = useRef(null);
  const [open, setOpen] = useState(false);
  const reveal = useCallback(() => setOpen(true), []);
  useEffect(() => {
    if (!open || pinned) return undefined;
    const gap = (rect, x, y) => Math.hypot(Math.max(rect.left - x, 0, x - rect.right), Math.max(rect.top - y, 0, y - rect.bottom));
    const move = e => {
      const rects = [toolbarRef.current, tabRef.current].filter(Boolean).map(el => el.getBoundingClientRect());
      if (!rects.length) return;
      if (Math.min(...rects.map(r => gap(r, e.clientX, e.clientY))) > distance) {
        // Keep it open while keyboard focus is inside the toolbar.
        if (toolbarRef.current?.contains(document.activeElement)) return;
        setOpen(false);
      }
    };
    const leaveWindow = e => { if (!e.relatedTarget) setOpen(false); };
    window.addEventListener('pointermove', move);
    document.addEventListener('pointerout', leaveWindow);
    return () => { window.removeEventListener('pointermove', move); document.removeEventListener('pointerout', leaveWindow); };
  }, [open, pinned, distance]);
  return { toolbarRef, tabRef, open: open || pinned, reveal, hide: () => setOpen(false) };
}
