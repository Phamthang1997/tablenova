/**
 * Interactive Control Toolbar for Visual BI Lite.
 * Provides controls for:
 * - Chart Type switching (Bar, Horizontal Bar, Line, Area, Pie, Donut)
 * - X Dimension and Y Measures selection
 * - Aggregation function selection
 * - Sorting, Stacked mode, Gridlines toggling
 * - Image export & Copying
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  BarChart2, LineChart, PieChart, TrendingUp, Layers,
  Grid, Eye, Download, Copy, Check
} from 'lucide-react';
import type { ChartConfig, ChartType, AggregationFn, SortOption, ColumnMeta } from './chartDataEngine';

/**
 * Module level, holding translation KEYS rather than text — the table is then built once instead of
 * on every render, and `t()` still runs inside the component so a language switch re-renders it.
 */
const CHART_TYPES: { type: ChartType; labelKey: 'chart.typeBar' | 'chart.typeHBar' | 'chart.typeLine' | 'chart.typeArea' | 'chart.typePie' | 'chart.typeDonut'; icon: React.ReactNode }[] = [
  { type: 'bar', labelKey: 'chart.typeBar', icon: <BarChart2 size={14} /> },
  { type: 'horizontalBar', labelKey: 'chart.typeHBar', icon: <BarChart2 size={14} className="bi-rotate-90" /> },
  { type: 'line', labelKey: 'chart.typeLine', icon: <LineChart size={14} /> },
  { type: 'area', labelKey: 'chart.typeArea', icon: <TrendingUp size={14} /> },
  { type: 'pie', labelKey: 'chart.typePie', icon: <PieChart size={14} /> },
  { type: 'donut', labelKey: 'chart.typeDonut', icon: <PieChart size={14} /> },
];

export interface ChartToolbarProps {
  config: ChartConfig;
  onChangeConfig: (newConfig: ChartConfig) => void;
  columns: ColumnMeta[];
  onCopyImage: () => void;
  onDownloadImage: () => void;
  isCopied: boolean;
}

export const ChartToolbar: React.FC<ChartToolbarProps> = ({
  config,
  onChangeConfig,
  columns,
  onCopyImage,
  onDownloadImage,
  isCopied,
}) => {
  const { t } = useTranslation();

  const handleTypeChange = (type: ChartType) => {
    onChangeConfig({ ...config, chartType: type });
  };

  const handleXChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    onChangeConfig({ ...config, xColumn: e.target.value });
  };

  const handleYToggle = (colName: string) => {
    let newY = [...config.yColumns];
    if (newY.includes(colName)) {
      if (newY.length > 1) {
        newY = newY.filter((c) => c !== colName);
      }
    } else {
      newY.push(colName);
    }
    onChangeConfig({ ...config, yColumns: newY });
  };

  const handleAggChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    onChangeConfig({ ...config, aggregation: e.target.value as AggregationFn });
  };

  const handleSortChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    onChangeConfig({ ...config, sortBy: e.target.value as SortOption });
  };

  return (
    <div className="bi-toolbar-container">
      {/* Chart Type Selector Group */}
      <div className="bi-toolbar-section">
        <span className="bi-section-label">{t('chart.typeLabel')}</span>
        <div className="bi-btn-group">
          {CHART_TYPES.map((item) => {
            const label = t(item.labelKey);
            return (
              <button
                key={item.type}
                type="button"
                className={`bi-type-btn ${config.chartType === item.type ? 'active' : ''}`}
                onClick={() => handleTypeChange(item.type)}
                title={t('chart.typeButtonTitle', { name: label })}
              >
                {item.icon}
                <span>{label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="bi-toolbar-divider" />

      {/* Dimension (X-Axis) Dropdown */}
      <div className="bi-toolbar-section">
        <span className="bi-section-label">{t('chart.xAxisLabel')}</span>
        <select
          className="bi-select"
          value={config.xColumn}
          onChange={handleXChange}
          title={t('chart.xAxisTitle')}
        >
          {columns.map((col) => (
            <option key={col.name} value={col.name}>
              {col.name} ({col.type})
            </option>
          ))}
        </select>
      </div>

      {/* Measure (Y-Axis) Multi-Selection Pills */}
      <div className="bi-toolbar-section">
        <span className="bi-section-label">{t('chart.yMetricLabel')}</span>
        <div className="bi-measure-pills">
          {[...columns]
            .sort((a, b) => {
              if (a.type === 'numeric' && b.type !== 'numeric') return -1;
              if (a.type !== 'numeric' && b.type === 'numeric') return 1;
              return 0;
            })
            .map((col) => {
              const isSelected = config.yColumns.includes(col.name);
              return (
                <button
                  key={col.name}
                  type="button"
                  className={`bi-measure-pill ${isSelected ? 'selected' : ''}`}
                  onClick={() => handleYToggle(col.name)}
                  title={t('chart.toggleMetric', { col: col.name })}
                >
                  {col.name}
                </button>
              );
            })}
        </div>
      </div>

      <div className="bi-toolbar-divider" />

      {/* Aggregation Function Dropdown */}
      <div className="bi-toolbar-section">
        <span className="bi-section-label">{t('chart.aggregateLabel')}</span>
        <select
          className="bi-select"
          value={config.aggregation}
          onChange={handleAggChange}
          title={t('chart.aggregateTitle')}
        >
          {/* SUM / AVG / COUNT / MIN / MAX stay as they are: they name SQL aggregate functions,
              the same way keywords are left alone everywhere else in the app. */}
          <option value="none">{t('chart.aggRaw')}</option>
          <option value="sum">SUM</option>
          <option value="avg">AVG</option>
          <option value="count">COUNT</option>
          <option value="min">MIN</option>
          <option value="max">MAX</option>
        </select>
      </div>

      {/* Sorting Dropdown */}
      <div className="bi-toolbar-section">
        <span className="bi-section-label">{t('chart.sortLabel')}</span>
        <select
          className="bi-select"
          value={config.sortBy}
          onChange={handleSortChange}
          title={t('chart.sortTitle')}
        >
          <option value="none">{t('chart.sortDefault')}</option>
          <option value="x-asc">{t('chart.sortXAsc')}</option>
          <option value="x-desc">{t('chart.sortXDesc')}</option>
          <option value="y-desc">{t('chart.sortYDesc')}</option>
          <option value="y-asc">{t('chart.sortYAsc')}</option>
        </select>
      </div>

      <div className="bi-toolbar-spacer" />

      {/* Chart Toggles (Stacked, Grid, Legend) */}
      <div className="bi-toolbar-section">
        {config.chartType === 'bar' && (
          <button
            type="button"
            className={`bi-icon-toggle ${config.isStacked ? 'active' : ''}`}
            onClick={() => onChangeConfig({ ...config, isStacked: !config.isStacked })}
            title={t('chart.toggleStacked')}
          >
            <Layers size={14} />
          </button>
        )}

        <button
          type="button"
          className={`bi-icon-toggle ${config.showGridlines ? 'active' : ''}`}
          onClick={() => onChangeConfig({ ...config, showGridlines: !config.showGridlines })}
          title={t('chart.toggleGridlines')}
        >
          <Grid size={14} />
        </button>

        <button
          type="button"
          className={`bi-icon-toggle ${config.showLegend ? 'active' : ''}`}
          onClick={() => onChangeConfig({ ...config, showLegend: !config.showLegend })}
          title={t('chart.toggleLegend')}
        >
          <Eye size={14} />
        </button>
      </div>

      <div className="bi-toolbar-divider" />

      {/* Export & Copy Actions */}
      <div className="bi-toolbar-section">
        <button
          type="button"
          className="bi-action-btn"
          onClick={onCopyImage}
          title={t('chart.copyTitle')}
        >
          {isCopied ? <Check size={13} className="bi-text-success" /> : <Copy size={13} />}
          <span>{isCopied ? t('chart.copied') : t('chart.copy')}</span>
        </button>

        <button
          type="button"
          className="bi-action-btn primary"
          onClick={onDownloadImage}
          title={t('chart.exportTitle')}
        >
          <Download size={13} />
          <span>{t('chart.exportPng')}</span>
        </button>
      </div>
    </div>
  );
};
