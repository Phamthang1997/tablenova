/**
 * Chart Data Processing & Aggregation Engine for Visual BI Lite.
 * Analyzes SQL query results / DataGrid rows to:
 * 1. Automatically detect Dimension (X-Axis) and Measure/Metric (Y-Axis) candidate columns.
 * 2. Compute group-by aggregations (SUM, AVG, COUNT, MIN, MAX, Raw).
 * 3. Generate tailored HSL color palettes for dark and light UI themes.
 * 4. Format numbers, currencies, and dates for chart tooltips and axes.
 */

export type ChartType = 'bar' | 'horizontalBar' | 'line' | 'area' | 'pie' | 'donut';
export type AggregationFn = 'none' | 'sum' | 'avg' | 'count' | 'min' | 'max';
export type SortOption = 'none' | 'x-asc' | 'x-desc' | 'y-desc' | 'y-asc';

export interface ColumnMeta {
  name: string;
  type: 'numeric' | 'temporal' | 'categorical' | 'boolean' | 'unknown';
  sampleValue?: any;
}

export interface ChartConfig {
  chartType: ChartType;
  xColumn: string;
  yColumns: string[];
  aggregation: AggregationFn;
  sortBy: SortOption;
  showGridlines: boolean;
  showLegend: boolean;
  isStacked: boolean;
}

export interface ProcessedChartData {
  labels: string[];
  datasets: {
    label: string;
    data: number[];
    backgroundColor: string | string[];
    borderColor: string | string[];
    borderWidth?: number;
    fill?: boolean | string;
    tension?: number;
    pointRadius?: number;
    pointHoverRadius?: number;
    pointBackgroundColor?: string;
  }[];
  stats: {
    totalPoints: number;
    columnSummaries: {
      column: string;
      sum: number;
      avg: number;
      min: number;
      max: number;
    }[];
  };
}

// Curated modern vibrant HSL color palette
const BASE_HUES = [217, 142, 262, 330, 38, 187, 15, 290, 84, 199];

/**
 * Analyzes columns and their data types from rows.
 */
export function analyzeColumns(rows: Record<string, any>[], columnNames?: string[]): ColumnMeta[] {
  if (!rows || rows.length === 0) {
    return (columnNames || []).map((name) => ({ name, type: 'unknown' }));
  }

  const keys = columnNames && columnNames.length > 0 ? columnNames : Object.keys(rows[0] || {});
  const sampleLimit = Math.min(rows.length, 50);

  return keys.map((key) => {
    let numericCount = 0;
    let dateCount = 0;
    let boolCount = 0;
    let validCount = 0;
    let sampleValue: any = undefined;

    for (let i = 0; i < sampleLimit; i++) {
      const val = rows[i]?.[key];
      if (val === null || val === undefined || val === '') continue;

      if (sampleValue === undefined) sampleValue = val;
      validCount++;

      if (typeof val === 'number') {
        numericCount++;
      } else if (typeof val === 'boolean') {
        boolCount++;
      } else if (typeof val === 'string') {
        const trimmed = val.trim();
        if (!isNaN(Number(trimmed)) && trimmed !== '') {
          numericCount++;
        } else if (/^\d{4}-\d{2}-\d{2}/.test(trimmed) || (!isNaN(Date.parse(trimmed)) && trimmed.length > 7 && !/^\d+$/.test(trimmed))) {
          dateCount++;
        }
      }
    }

    const lowerKey = key.toLowerCase();
    let type: ColumnMeta['type'] = 'categorical';

    if (validCount > 0 && numericCount / validCount > 0.8 && !lowerKey.endsWith('_id') && lowerKey !== 'id') {
      type = 'numeric';
    } else if (validCount > 0 && dateCount / validCount > 0.6) {
      type = 'temporal';
    } else if (validCount > 0 && boolCount / validCount > 0.8) {
      type = 'boolean';
    } else if (lowerKey.includes('date') || lowerKey.includes('time') || lowerKey.endsWith('_at')) {
      type = 'temporal';
    } else if (
      lowerKey.includes('amount') ||
      lowerKey.includes('total') ||
      lowerKey.includes('price') ||
      lowerKey.includes('count') ||
      lowerKey.includes('salary') ||
      lowerKey.includes('qty') ||
      lowerKey.includes('rate') ||
      lowerKey.includes('cost') ||
      lowerKey.includes('score') ||
      lowerKey.includes('value')
    ) {
      type = 'numeric';
    }

    return { name: key, type, sampleValue };
  });
}

/**
 * Generates smart default chart configuration based on schema analysis.
 */
export function getDefaultChartConfig(columns: ColumnMeta[]): ChartConfig {
  const temporalCol = columns.find((c) => c.type === 'temporal');
  const categoricalCol = columns.find((c) => c.type === 'categorical' && !c.name.toLowerCase().endsWith('id'));
  const numericCols = columns.filter((c) => c.type === 'numeric');

  // Choose best X Dimension
  let xColumn = temporalCol?.name || categoricalCol?.name || columns[0]?.name || '';

  // Choose best Y Metrics
  let yColumns: string[] = [];
  if (numericCols.length > 0) {
    yColumns = [numericCols[0].name];
  } else if (columns.length > 1) {
    const fallbackY = columns.find((c) => c.name !== xColumn);
    if (fallbackY) yColumns = [fallbackY.name];
  }

  // Choose default chart type
  let chartType: ChartType = 'bar';
  if (temporalCol && xColumn === temporalCol.name) {
    chartType = 'line';
  }

  return {
    chartType,
    xColumn,
    yColumns,
    aggregation: 'none',
    sortBy: 'none',
    showGridlines: true,
    showLegend: true,
    isStacked: false,
  };
}

/**
 * Processes raw rows into Chart.js dataset format with aggregations and sorting.
 */
export function processChartData(
  rows: Record<string, any>[],
  config: ChartConfig,
  isDarkMode: boolean = true
): ProcessedChartData {
  if (!rows || rows.length === 0 || !config.xColumn || config.yColumns.length === 0) {
    return {
      labels: [],
      datasets: [],
      stats: { totalPoints: 0, columnSummaries: [] },
    };
  }

  const { xColumn, yColumns, aggregation, sortBy, chartType } = config;

  // 1. Grouping and aggregation computation
  let intermediateData: { xVal: string; metrics: Record<string, number> }[] = [];

  if (aggregation === 'none') {
    intermediateData = rows.map((row) => {
      const xRaw = row[xColumn];
      const xVal = xRaw === null || xRaw === undefined ? 'NULL' : String(xRaw);
      const metrics: Record<string, number> = {};

      for (const yCol of yColumns) {
        const rawNum = Number(row[yCol]);
        metrics[yCol] = isNaN(rawNum) ? 0 : rawNum;
      }

      return { xVal, metrics };
    });
  } else {
    // Group by xColumn
    const groups = new Map<string, Record<string, number[]>>();

    for (const row of rows) {
      const xRaw = row[xColumn];
      const xVal = xRaw === null || xRaw === undefined ? 'NULL' : String(xRaw);

      if (!groups.has(xVal)) {
        groups.set(xVal, {});
        for (const yCol of yColumns) {
          groups.get(xVal)![yCol] = [];
        }
      }

      const groupMetrics = groups.get(xVal)!;
      for (const yCol of yColumns) {
        const rawNum = Number(row[yCol]);
        if (!isNaN(rawNum)) {
          groupMetrics[yCol].push(rawNum);
        }
      }
    }

    groups.forEach((groupMetrics, xVal) => {
      const aggregatedMetrics: Record<string, number> = {};

      for (const yCol of yColumns) {
        const values = groupMetrics[yCol] || [];
        if (values.length === 0) {
          aggregatedMetrics[yCol] = 0;
          continue;
        }

        switch (aggregation) {
          case 'sum':
            aggregatedMetrics[yCol] = values.reduce((a, b) => a + b, 0);
            break;
          case 'avg':
            aggregatedMetrics[yCol] = values.reduce((a, b) => a + b, 0) / values.length;
            break;
          case 'count':
            aggregatedMetrics[yCol] = values.length;
            break;
          case 'min':
            aggregatedMetrics[yCol] = Math.min(...values);
            break;
          case 'max':
            aggregatedMetrics[yCol] = Math.max(...values);
            break;
          default:
            aggregatedMetrics[yCol] = values[0] || 0;
        }
      }

      intermediateData.push({ xVal, metrics: aggregatedMetrics });
    });
  }

  // 2. Sorting
  if (sortBy === 'x-asc') {
    intermediateData.sort((a, b) => a.xVal.localeCompare(b.xVal, undefined, { numeric: true }));
  } else if (sortBy === 'x-desc') {
    intermediateData.sort((a, b) => b.xVal.localeCompare(a.xVal, undefined, { numeric: true }));
  } else if (sortBy === 'y-desc') {
    const primaryY = yColumns[0];
    intermediateData.sort((a, b) => (b.metrics[primaryY] || 0) - (a.metrics[primaryY] || 0));
  } else if (sortBy === 'y-asc') {
    const primaryY = yColumns[0];
    intermediateData.sort((a, b) => (a.metrics[primaryY] || 0) - (b.metrics[primaryY] || 0));
  }

  // 3. Build Labels and Datasets
  const labels = intermediateData.map((d) => d.xVal);
  const isPieOrDonut = chartType === 'pie' || chartType === 'donut';

  const datasets = yColumns.map((yCol, colIdx) => {
    const data = intermediateData.map((d) => Number((d.metrics[yCol] || 0).toFixed(2)));
    const hue = BASE_HUES[colIdx % BASE_HUES.length];

    if (isPieOrDonut) {
      // Slices have distinct colors for each category
      const sliceColors = labels.map((_, sliceIdx) => {
        const sliceHue = BASE_HUES[sliceIdx % BASE_HUES.length];
        return isDarkMode ? `hsla(${sliceHue}, 80%, 55%, 0.85)` : `hsla(${sliceHue}, 75%, 50%, 0.85)`;
      });
      const borderColors = labels.map((_, sliceIdx) => {
        const sliceHue = BASE_HUES[sliceIdx % BASE_HUES.length];
        return isDarkMode ? `hsl(${sliceHue}, 85%, 65%)` : `hsl(${sliceHue}, 80%, 45%)`;
      });

      return {
        label: yCol,
        data,
        backgroundColor: sliceColors,
        borderColor: borderColors,
        borderWidth: 1.5,
      };
    }

    const primaryColor = isDarkMode ? `hsl(${hue}, 85%, 60%)` : `hsl(${hue}, 80%, 48%)`;
    const fillColor =
      chartType === 'area'
        ? isDarkMode
          ? `hsla(${hue}, 85%, 60%, 0.25)`
          : `hsla(${hue}, 80%, 48%, 0.2)`
        : isDarkMode
        ? `hsla(${hue}, 85%, 60%, 0.75)`
        : `hsla(${hue}, 80%, 48%, 0.75)`;

    return {
      label: yCol,
      data,
      backgroundColor: fillColor,
      borderColor: primaryColor,
      borderWidth: chartType === 'line' || chartType === 'area' ? 2.5 : 1,
      fill: chartType === 'area' ? 'origin' : false,
      tension: chartType === 'line' || chartType === 'area' ? 0.35 : 0,
      pointRadius: labels.length > 60 ? 0 : 3.5,
      pointHoverRadius: 6,
      pointBackgroundColor: primaryColor,
    };
  });

  // 4. Compute Statistical Summary for KPI cards
  const columnSummaries = yColumns.map((yCol) => {
    const vals = intermediateData.map((d) => d.metrics[yCol] || 0);
    const sum = vals.reduce((a, b) => a + b, 0);
    const avg = vals.length > 0 ? sum / vals.length : 0;
    const min = vals.length > 0 ? Math.min(...vals) : 0;
    const max = vals.length > 0 ? Math.max(...vals) : 0;

    return { column: yCol, sum, avg, min, max };
  });

  return {
    labels,
    datasets,
    stats: {
      totalPoints: labels.length,
      columnSummaries,
    },
  };
}

/**
 * Formats large numbers compactly for chart axis labels (e.g. 1.2K, 3.5M).
 */
export function formatCompactNumber(val: number): string {
  if (Math.abs(val) >= 1_000_000_000) return `${(val / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(val) >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`;
  if (Math.abs(val) >= 1_000) return `${(val / 1_000).toFixed(1)}K`;
  return Number.isInteger(val) ? String(val) : val.toFixed(2);
}
