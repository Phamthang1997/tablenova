import React, { Suspense } from 'react';
import { LazyEditorFallback } from '../LazyEditorFallback';
import type { DataVisualizerProps } from './DataVisualizer';

/**
 * The lazy boundary in front of the whole chart feature.
 *
 * `chart.js` registers every controller, scale and element at import time (`chartSetup.ts`), and
 * `DataGrid` — which App imports statically — pulled it in through `./chart`. So ~200kB of charting
 * library was parsed and executed during startup for every user, including the ones who never open
 * the Chart tab. This is the same trap CLAUDE.md documents for Monaco, and the same fix.
 *
 * The rule that keeps it working: **the rest of the app imports the chart feature only through
 * `./chart`**, whose index exports this wrapper and nothing else at runtime. A static import of
 * `./chart/DataVisualizer`, `./chart/chartSetup` or `./chart/ChartToolbar` from any module the
 * entry reaches undoes the split silently — nothing fails, the bundle just grows again. Verify with
 * `npm run build-frontend`: the chart chunk must not appear as a `modulepreload` in `dist/index.html`.
 *
 * The type import above is erased at compile time and so costs nothing.
 */
const DataVisualizerLazy = React.lazy(() =>
  import('./DataVisualizer').then((m) => ({ default: m.DataVisualizer })));

/**
 * `LazyEditorFallback` is the right shape here: it carries `flex: 1` and a background, which is
 * what a panel needs so the surrounding layout does not collapse and snap back when the chunk lands.
 */
export const DataVisualizer: React.FC<DataVisualizerProps> = (props) => (
  <Suspense fallback={<LazyEditorFallback />}>
    <DataVisualizerLazy {...props} />
  </Suspense>
);
