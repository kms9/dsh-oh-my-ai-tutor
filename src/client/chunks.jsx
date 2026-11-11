import React, { forwardRef, useEffect, useState } from 'react';

/**
 * Per-view lazy loading. In DSH the heavy views live in package-local chunks next to lib/client.js
 * (lib/client.flow.js = React Flow board + graph, lib/client.mindmap.js = mind-elixir), fetched on first use through the
 * host module loader's `require.async("./client.<name>.js")`. The standalone harness registers the same modules
 * statically. Nothing else changes: the chunks get the host's React from the same module table.
 */
const cache = new Map(); // name → { mod } | { error } | Promise
let loader = null;
export function setChunkLoader(fn) { loader = fn; }
export function loadChunk(name) {
  const hit = cache.get(name);
  if (hit) return hit instanceof Promise ? hit : Promise.resolve(hit);
  if (!loader) return Promise.resolve({ error: new Error('chunk loader not configured') });
  const p = Promise.resolve().then(() => loader(name)).then((mod) => ({ mod }), (error) => ({ error }))
    .then((r) => { if (r.error) cache.delete(name); else cache.set(name, r); return r; });
  cache.set(name, p);
  return p;
}
function useChunk(name) {
  const [state, setState] = useState(() => { const hit = cache.get(name); return hit && !(hit instanceof Promise) ? hit : null; });
  useEffect(() => {
    if (state?.mod) return undefined;
    let alive = true;
    loadChunk(name).then((r) => { if (alive) setState(r); });
    return () => { alive = false; };
  }, [name, state]);
  return state;
}
/** A component from a lazily loaded chunk, with ref pass-through and a small loading / error placeholder. */
export function lazyComponent(chunk, exportName, placeholderHeight = 320) {
  const Lazy = forwardRef(function Lazy(props, ref) {
    const s = useChunk(chunk);
    if (s?.mod) { const C = s.mod[exportName]; return <C {...props} ref={ref} />; }
    return (
      <div className="empty chunk-wait" data-testid={`chunk-${chunk}`} style={{ height: props.height ?? placeholderHeight, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {s?.error ? `视图加载失败：${s.error.message}` : '正在加载视图…'}
      </div>
    );
  });
  Lazy.displayName = `Lazy(${exportName})`;
  return Lazy;
}
