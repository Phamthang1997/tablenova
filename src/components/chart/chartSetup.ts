/**
 * Chart.js setup and registration for TableNova.
 * Registers necessary controllers, scales, elements, and plugins.
 */

import {
  Chart as ChartJS,
  registerables,
  type ChartConfiguration,
  type ChartOptions,
} from 'chart.js';
import type { ChartConfig, ProcessedChartData } from './chartDataEngine';
import { formatCompactNumber } from './chartDataEngine';

// Register all Chart.js components and controllers
ChartJS.register(...registerables);

/**
 * Builds Chart.js configuration options based on user settings and UI theme.
 */
/**
 * Above this many points the entry animation is dropped.
 *
 * An animation is not one draw, it is ~18 frames of redrawing EVERY element, so its cost is the
 * per-frame draw multiplied by the frame count — the one place where a big chart stops being slow
 * and becomes a freeze. Under a few hundred elements the movement is worth it and costs nothing;
 * past that it is a stutter the user has to sit through before seeing their data.
 */
const ANIMATION_POINT_LIMIT = 300;

export function buildChartOptions(
  config: ChartConfig,
  isDarkMode: boolean = true,
  pointCount: number = 0
): ChartOptions {
  const { chartType, isStacked, showGridlines, showLegend } = config;
  const isHorizontal = chartType === 'horizontalBar';
  const isPieOrDonut = chartType === 'pie' || chartType === 'donut';

  const textColor = isDarkMode ? '#94a3b8' : '#64748b';
  const gridColor = isDarkMode ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.07)';
  const tooltipBg = isDarkMode ? '#1e222b' : '#ffffff';
  const tooltipTitleColor = isDarkMode ? '#f8fafc' : '#0f172a';
  const tooltipBodyColor = isDarkMode ? '#cbd5e1' : '#334155';
  const tooltipBorder = isDarkMode ? '#383e4a' : '#e2e8f0';

  const options: ChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    indexAxis: isHorizontal ? 'y' : 'x',
    animation: pointCount > ANIMATION_POINT_LIMIT ? false : { duration: 300 },
    plugins: {
      legend: {
        display: showLegend,
        position: isPieOrDonut ? 'right' : 'top',
        labels: {
          color: textColor,
          font: { family: 'inherit', size: 11, weight: 'bold' as const },
          boxWidth: 12,
          boxHeight: 12,
          padding: 12,
        },
      },
      tooltip: {
        backgroundColor: tooltipBg,
        titleColor: tooltipTitleColor,
        bodyColor: tooltipBodyColor,
        borderColor: tooltipBorder,
        borderWidth: 1,
        padding: 10,
        cornerRadius: 6,
        boxPadding: 4,
        titleFont: { weight: 'bold' as const, size: 12 },
        bodyFont: { size: 11 },
        callbacks: {
          label: (context) => {
            const label = context.dataset.label || '';
            const val = context.parsed.y !== undefined ? context.parsed.y : context.parsed;
            return ` ${label}: ${Number(val).toLocaleString()}`;
          },
        },
      },
    },
  };

  if (!isPieOrDonut) {
    options.scales = {
      x: {
        stacked: isStacked,
        grid: {
          display: showGridlines,
          color: gridColor,
        },
        ticks: {
          color: textColor,
          font: { family: 'inherit', size: 10 },
          maxRotation: 45,
          minRotation: 0,
        },
      },
      y: {
        stacked: isStacked,
        grid: {
          display: showGridlines,
          color: gridColor,
        },
        ticks: {
          color: textColor,
          font: { family: 'inherit', size: 10 },
          callback: (value) => formatCompactNumber(Number(value)),
        },
      },
    };
  }

  return options;
}

/**
 * Chart.js's own name for one of our chart types — two of ours are the same Chart.js type wearing
 * different options (`horizontalBar` is a `bar` with `indexAxis: 'y'`).
 *
 * Exported because `DataVisualizer` compares it against a live instance's type to decide whether it
 * can update in place or has to rebuild; keeping the mapping in one place is what stops those two
 * decisions from drifting apart.
 */
export function chartJsTypeFor(chartType: ChartConfig['chartType']): string {
  return chartType === 'horizontalBar' ? 'bar' : chartType === 'donut' ? 'doughnut' : chartType;
}

/**
 * Initializes or updates a Chart.js instance on a canvas element.
 */
export function createChartInstance(
  canvas: HTMLCanvasElement,
  processedData: ProcessedChartData,
  config: ChartConfig,
  isDarkMode: boolean = true
): ChartJS {
  const chartType = chartJsTypeFor(config.chartType);

  const chartConfig: ChartConfiguration = {
    type: chartType as any,
    data: {
      labels: processedData.labels,
      datasets: processedData.datasets as any,
    },
    options: buildChartOptions(config, isDarkMode, processedData.labels.length),
  };

  return new ChartJS(canvas, chartConfig);
}

export { ChartJS };
