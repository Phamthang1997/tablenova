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
import {
  BarChart2, LineChart, PieChart, TrendingUp, Layers,
  Grid, Eye, Download, Copy, Check
} from 'lucide-react';
import type { ChartConfig, ChartType, AggregationFn, SortOption, ColumnMeta } from './chartDataEngine';

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
  const chartTypes: { type: ChartType; label: string; icon: React.ReactNode }[] = [
    { type: 'bar', label: 'Bar', icon: <BarChart2 size={14} /> },
    { type: 'horizontalBar', label: 'H-Bar', icon: <BarChart2 size={14} className="bi-rotate-90" /> },
    { type: 'line', label: 'Line', icon: <LineChart size={14} /> },
    { type: 'area', label: 'Area', icon: <TrendingUp size={14} /> },
    { type: 'pie', label: 'Pie', icon: <PieChart size={14} /> },
    { type: 'donut', label: 'Donut', icon: <PieChart size={14} /> },
  ];

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
        <span className="bi-section-label">Type:</span>
        <div className="bi-btn-group">
          {chartTypes.map((item) => (
            <button
              key={item.type}
              type="button"
              className={`bi-type-btn ${config.chartType === item.type ? 'active' : ''}`}
              onClick={() => handleTypeChange(item.type)}
              title={`${item.label} Chart`}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="bi-toolbar-divider" />

      {/* Dimension (X-Axis) Dropdown */}
      <div className="bi-toolbar-section">
        <span className="bi-section-label">X Axis:</span>
        <select
          className="bi-select"
          value={config.xColumn}
          onChange={handleXChange}
          title="Select X-Axis Dimension"
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
        <span className="bi-section-label">Y Metric:</span>
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
                  title={`Toggle metric ${col.name}`}
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
        <span className="bi-section-label">Aggregate:</span>
        <select
          className="bi-select"
          value={config.aggregation}
          onChange={handleAggChange}
          title="Select Aggregation Function"
        >
          <option value="none">Raw Rows</option>
          <option value="sum">SUM</option>
          <option value="avg">AVG</option>
          <option value="count">COUNT</option>
          <option value="min">MIN</option>
          <option value="max">MAX</option>
        </select>
      </div>

      {/* Sorting Dropdown */}
      <div className="bi-toolbar-section">
        <span className="bi-section-label">Sort:</span>
        <select
          className="bi-select"
          value={config.sortBy}
          onChange={handleSortChange}
          title="Sort Chart Order"
        >
          <option value="none">Default</option>
          <option value="x-asc">X (A → Z)</option>
          <option value="x-desc">X (Z → A)</option>
          <option value="y-desc">Y (High → Low)</option>
          <option value="y-asc">Y (Low → High)</option>
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
            title="Toggle Stacked Bars"
          >
            <Layers size={14} />
          </button>
        )}

        <button
          type="button"
          className={`bi-icon-toggle ${config.showGridlines ? 'active' : ''}`}
          onClick={() => onChangeConfig({ ...config, showGridlines: !config.showGridlines })}
          title="Toggle Gridlines"
        >
          <Grid size={14} />
        </button>

        <button
          type="button"
          className={`bi-icon-toggle ${config.showLegend ? 'active' : ''}`}
          onClick={() => onChangeConfig({ ...config, showLegend: !config.showLegend })}
          title="Toggle Legend"
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
          title="Copy chart image to clipboard"
        >
          {isCopied ? <Check size={13} className="bi-text-success" /> : <Copy size={13} />}
          <span>{isCopied ? 'Copied' : 'Copy'}</span>
        </button>

        <button
          type="button"
          className="bi-action-btn primary"
          onClick={onDownloadImage}
          title="Download chart image as PNG"
        >
          <Download size={13} />
          <span>Export PNG</span>
        </button>
      </div>
    </div>
  );
};
