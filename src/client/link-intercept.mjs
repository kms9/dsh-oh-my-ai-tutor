import { parseTutorHref, TUTOR_LINK_ORIGIN } from '../links.mjs';

/**
 * Clicks on internal tutor links (https://tutor.invalid/<kind>/<id>) anywhere in the page — DSH chat Markdown, our tool
 * cards, the workbench — open the workbench at that object instead of a browser tab.
 *
 * Capture phase on window: runs before React's root listener, so DSH's own link handler (sidebar browser /
 * window.open) never sees the click. Middle click / ctrl / meta click are caught too (auxclick), so a tutor link
 * never opens a dead tab. Every other link is left alone.
 */
export function installTutorLinks(onOpen, target = typeof window === 'undefined' ? null : window) {
  if (!target) return () => {};
  const handler = (e) => {
    if (e.type === 'auxclick' && e.button !== 1) return;
    const a = e.target?.closest?.(`a[href^="${TUTOR_LINK_ORIGIN}/"]`);
    if (!a) return;
    const link = parseTutorHref(a.getAttribute('href'));
    if (!link) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation?.();
    onOpen(link);
  };
  target.addEventListener('click', handler, true);
  target.addEventListener('auxclick', handler, true);
  return () => { target.removeEventListener('click', handler, true); target.removeEventListener('auxclick', handler, true); };
}

/** The view a link opens on (the workbench tab); `focus` carries the object. */
export function viewFor(link) {
  return { concept: 'data', card: 'board', note: undefined, lesson: undefined, topic: 'outline', outline: 'outline' }[link.kind];
}
