/**
 * DataVisualizer: Main Visual BI Lite Component.
 * Transforms raw database query results and table data into interactive, beautiful charts.
 * Supports Bar, Horizontal Bar, Line, Area, Pie, Donut with real-time aggregations and KPI summaries.
 */

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BarChart3, X, AlertCircle
} from 'lucide-react';
import {
  analyzeColumns,
  getDefaultChartConfig,
  processChartData,
  formatCompactNumber,
  MAX_PLOT_POINTS,
  type ChartConfig,
  type ProcessedChartData,
  type ColumnMeta,
} from './chartDataEngine';
import { createChartInstance, buildChartOptions, chartJsTypeFor, ChartJS } from './chartSetup';
import { ChartToolbar } from './ChartToolbar';

export interface DataVisualizerProps {
  rows: Record<string, any>[];
  columnNames?: string[];
  title?: string;
  tableName?: string;
  onClose?: () => void;
  isModal?: boolean;
}

export const DataVisualizer: React.FC<DataVisualizerProps> = ({
  rows,
  columnNames,
  title,
  tableName,
  onClose,
  isModal = false,
}) => {
  const { t, i18n } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartInstanceRef = useRef<ChartJS | null>(null);
  const [isCopied, setIsCopied] = useState<boolean>(false);
  const [isDarkMode, setIsDarkMode] = useState<boolean>(true);

  // Detect UI theme (dark vs light) from document body or data-theme attribute
  useEffect(() => {
    const checkTheme = () => {
      const themeAttr = document.documentElement.getAttribute('data-theme') || document.body.getAttribute('data-theme');
      setIsDarkMode(themeAttr !== 'light');
    };
    checkTheme();

    const observer = new MutationObserver(checkTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    return () => observer.disconnect();
  }, []);

  // 1. Column analysis and metadata
  const columns: ColumnMeta[] = useMemo(() => {
    return analyzeColumns(rows, columnNames);
  }, [rows, columnNames]);

  // 2. Chart Configuration State
  const [config, setConfig] = useState<ChartConfig>(() => getDefaultChartConfig(columns));

  // Reset or adjust configuration if columns change
  useEffect(() => {
    if (columns.length > 0) {
      // set-state-in-effect: this reconciles state against new input rather than deriving it. The
      // functional update is the point - it keeps the user's own column picks when they are still
      // valid and only falls back to the default when one of them no longer exists. Deriving the
      // config from `columns` during render would silently discard every choice they made.
      // eslint-disable-next-line react/set-state-in-effect
      setConfig((prev) => {
        const xExists = columns.some((c) => c.name === prev.xColumn);
        const yExists = prev.yColumns.some((y) => columns.some((c) => c.name === y));
        if (!xExists || !yExists) {
          return getDefaultChartConfig(columns);
        }
        return prev;
      });
    }
  }, [columns]);

  // 3. Process chart data with aggregations and color mappings
  const processedData: ProcessedChartData = useMemo(() => {
    return processChartData(rows, config, isDarkMode);
  }, [rows, config, isDarkMode]);

  // 4. Render the chart, updating the live instance in place wherever Chart.js allows it.
  //
  // This effect used to destroy and rebuild the whole instance on every run, and it runs for every
  // toolbar change — ticking "show legend" threw away the chart and re-parsed every point to draw
  // the same picture with one box on it. `chart.update()` re-reads data and options and redraws,
  // which is what Chart.js provides for exactly this.
  //
  // Only a change of Chart.js TYPE still rebuilds, since that is a different controller. Note this
  // is the type Chart.js knows, not ours: bar <-> horizontal bar is one type with a different
  // `indexAxis`, so that switch goes through the update path too.
  //
  // Consequence for the cleanup: it can no longer live here. A cleanup runs before EVERY next run
  // of the effect, so destroying there would leave nothing to update; the instance is torn down on
  // unmount instead, by the effect below.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const destroyChart = () => {
      // `getChart` covers an instance still attached to this canvas that we lost the ref to — a
      // React strict-mode double-mount, or a hot reload.
      const attached = ChartJS.getChart(canvas);
      if (attached) attached.destroy();
      if (chartInstanceRef.current) {
        chartInstanceRef.current.destroy();
        chartInstanceRef.current = null;
      }
    };

    if (processedData.labels.length === 0 || processedData.datasets.length === 0) {
      destroyChart();
      return;
    }

    const chart = chartInstanceRef.current;
    // `chart.config` is a union in Chart.js's own types and only one arm of it carries `type`. We
    // always build with one, so the `in` check is simply how the compiler is told that.
    const liveType = chart && 'type' in chart.config ? chart.config.type : null;
    if (chart && liveType === chartJsTypeFor(config.chartType)) {
      chart.data.labels = processedData.labels;
      chart.data.datasets = processedData.datasets as any;
      chart.options = buildChartOptions(config, isDarkMode, processedData.labels.length);
      chart.update();
      return;
    }

    destroyChart();
    try {
      chartInstanceRef.current = createChartInstance(canvas, processedData, config, isDarkMode);
    } catch (err) {
      console.error('Failed to create Chart.js instance:', err);
    }
  }, [processedData, config, isDarkMode]);

  // Teardown, on unmount only. A canvas that outlives its Chart.js instance keeps the whole dataset
  // alive through the instance's own registry, so this is not optional.
  useEffect(() => {
    const canvas = canvasRef.current;
    return () => {
      if (canvas) {
        const attached = ChartJS.getChart(canvas);
        if (attached) attached.destroy();
      }
      if (chartInstanceRef.current) {
        chartInstanceRef.current.destroy();
        chartInstanceRef.current = null;
      }
    };
  }, []);

  // Copy rendered chart as high-res PNG to clipboard
  const handleCopyImage = useCallback(async () => {
    const chart = chartInstanceRef.current;
    if (!chart) return;

    try {
      const dataUrl = chart.toBase64Image('image/png', 1.0);
      const res = await fetch(dataUrl);
      const blob = await res.blob();

      if (navigator.clipboard && (window as any).ClipboardItem) {
        const item = new (window as any).ClipboardItem({ 'image/png': blob });
        await navigator.clipboard.write([item]);
        setIsCopied(true);
        setTimeout(() => setIsCopied(false), 2000);
      }
    } catch (err) {
      console.error('Failed to copy chart image:', err);
    }
  }, []);

  // Download chart as high-res PNG file
  const handleDownloadImage = useCallback(() => {
    const chart = chartInstanceRef.current;
    if (!chart) return;

    const dataUrl = chart.toBase64Image('image/png', 1.0);
    const link = document.createElement('a');
    const filename = `${tableName || 'chart'}_${config.chartType}_${Date.now()}.png`;
    link.href = dataUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [tableName, config.chartType]);

  const hasData = processedData.labels.length > 0;

  return (
    <div className={`bi-visualizer-container ${isModal ? 'bi-modal-mode' : ''}`}>
      {/* Top Header Bar */}
      <div className="bi-header">
        <div className="bi-header-title-group">
          <BarChart3 size={18} className="bi-header-icon" />
          <span className="bi-header-title">
            {title || (tableName ? t('chart.titleFor', { name: tableName }) : t('chart.titleDefault'))}
          </span>
          <span className="bi-badge-count">
            {t('chart.rows', { n: rows.length.toLocaleString(i18n.language) })}
          </span>
          {/* Said out loud rather than silently drawing a slice: the cap changes WHICH data is on
              screen, so the row count next to it would otherwise be a lie. */}
          {processedData.stats.plottedPoints < processedData.stats.totalPoints && (
            <span
              className="bi-badge-count bi-badge-warn"
              title={t('chart.plotLimitedHint', {
                n: MAX_PLOT_POINTS.toLocaleString(i18n.language),
                total: processedData.stats.totalPoints.toLocaleString(i18n.language),
              })}
            >
              {t('chart.plotLimited', {
                n: processedData.stats.plottedPoints.toLocaleString(i18n.language),
                total: processedData.stats.totalPoints.toLocaleString(i18n.language),
              })}
            </span>
          )}
        </div>

        {onClose && (
          <button
            type="button"
            className="bi-close-btn"
            onClick={onClose}
            title={t('chart.close')}
          >
            <X size={16} />
          </button>
        )}
      </div>

      {/* Control & Customization Toolbar */}
      <ChartToolbar
        config={config}
        onChangeConfig={setConfig}
        columns={columns}
        onCopyImage={handleCopyImage}
        onDownloadImage={handleDownloadImage}
        isCopied={isCopied}
      />

      {/* KPI Summary Stat Cards */}
      {hasData && processedData.stats.columnSummaries.length > 0 && (
        <div className="bi-kpi-bar">
          <div className="bi-kpi-card">
            <span className="bi-kpi-label">{t('chart.kpiTotalPoints')}</span>
            <span className="bi-kpi-value">{processedData.stats.totalPoints.toLocaleString(i18n.language)}</span>
          </div>

          {processedData.stats.columnSummaries.map((summary) => (
            <div key={summary.column} className="bi-kpi-card">
              <span className="bi-kpi-label">{t('chart.kpiColumn', { col: summary.column })}</span>
              <span className="bi-kpi-value">
                {formatCompactNumber(summary.sum)}
                <span className="bi-kpi-sub"> ~ {formatCompactNumber(summary.avg)}</span>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Main Canvas Chart Area */}
      <div className="bi-canvas-container">
        {hasData ? (
          <div className="bi-canvas-wrapper">
            <canvas ref={canvasRef} className="bi-canvas" />
          </div>
        ) : (
          <div className="bi-empty-state">
            <AlertCircle size={32} className="bi-empty-icon" />
            <span className="bi-empty-text">{t('chart.emptyTitle')}</span>
            <span className="bi-empty-sub">{t('chart.emptyDesc')}</span>
          </div>
        )}
      </div>
    </div>
  );
};
