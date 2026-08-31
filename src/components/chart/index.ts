/**
 * Visual Chart & BI Lite module — the ONLY entry point the rest of the app may use.
 *
 * It deliberately exports one component and one type, both of which are free at startup: the
 * component is a lazy boundary and the type is erased. It used to `export *` from all four modules,
 * which put `chart.js` (and its `register(...registerables)` side effect) into the startup bundle
 * through `DataGrid`. See `LazyDataVisualizer.tsx` for the full reasoning — and do not add a
 * re-export here without checking what it drags in.
 */

export { DataVisualizer } from './LazyDataVisualizer';
export type { DataVisualizerProps } from './DataVisualizer';
