import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  ZoomIn, ZoomOut, RotateCcw, RotateCw, Copy, Check,
  Download, X, Image as ImageIcon
} from 'lucide-react';
import { type MediaInfo, formatByteSize } from '../../utils/mediaDetector';

export interface MediaViewerModalProps {
  isOpen: boolean;
  onClose: () => void;
  media: MediaInfo;
  columnName?: string;
  tableName?: string;
}

type BackgroundMode = 'dark' | 'black' | 'light' | 'checkerboard';

/**
 * Fullscreen Lightbox Modal for inspecting images and media data from database cells.
 * Provides interactive zoom, rotation, background mode toggle, clipboard copying, and file download.
 */
export const MediaViewerModal: React.FC<MediaViewerModalProps> = ({
  isOpen,
  onClose,
  media,
  columnName = 'image',
  tableName,
}) => {
  const [zoom, setZoom] = useState<number>(1);
  const [rotation, setRotation] = useState<number>(0);
  const [bgMode, setBgMode] = useState<BackgroundMode>('dark');
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const [copiedKind, setCopiedKind] = useState<'image' | 'url' | 'raw' | null>(null);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [panOffset, setPanOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const dragStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const imgRef = useRef<HTMLImageElement>(null);

  // Reset viewport state when opening a new media item
  useEffect(() => {
    if (isOpen) {
      setZoom(1);
      setRotation(0);
      setPanOffset({ x: 0, y: 0 });
      setCopiedKind(null);

      const img = new Image();
      img.referrerPolicy = 'no-referrer';
      img.onload = () => {
        setDimensions({ width: img.naturalWidth, height: img.naturalHeight });
      };
      img.src = media.displayUrl;
    }
  }, [isOpen, media.displayUrl]);

  // Handle keyboard shortcuts (Escape to close, +/- to zoom, R to rotate)
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === '+' || e.key === '=') {
        setZoom((z) => Math.min(5, Number((z + 0.25).toFixed(2))));
      } else if (e.key === '-' || e.key === '_') {
        setZoom((z) => Math.max(0.2, Number((z - 0.25).toFixed(2))));
      } else if (e.key === '0') {
        setZoom(1);
        setPanOffset({ x: 0, y: 0 });
      } else if (e.key.toLowerCase() === 'r') {
        setRotation((r) => (r + 90) % 360);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Handle mouse wheel zoom
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.15 : -0.15;
    setZoom((z) => Math.min(5, Math.max(0.2, Number((z + delta).toFixed(2)))));
  }, []);

  // Handle pan dragging
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setIsDragging(true);
    dragStartRef.current = { x: e.clientX - panOffset.x, y: e.clientY - panOffset.y };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    setPanOffset({
      x: e.clientX - dragStartRef.current.x,
      y: e.clientY - dragStartRef.current.y,
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  // Copy raw image blob to system clipboard
  const handleCopyImage = async () => {
    try {
      const response = await fetch(media.displayUrl);
      const blob = await response.blob();
      // Ensure format for system clipboard compatibility
      if (navigator.clipboard && (window as any).ClipboardItem) {
        const item = new (window as any).ClipboardItem({ [blob.type]: blob });
        await navigator.clipboard.write([item]);
        setCopiedKind('image');
        setTimeout(() => setCopiedKind(null), 2000);
      }
    } catch {
      // Fallback to text copy
      handleCopyText(media.displayUrl, 'url');
    }
  };

  // Copy URL or Base64 string to clipboard
  const handleCopyText = async (text: string, kind: 'url' | 'raw') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKind(kind);
      setTimeout(() => setCopiedKind(null), 2000);
    } catch (err) {
      console.error('Failed to copy text:', err);
    }
  };

  // Download image file to user's disk
  const handleDownload = () => {
    const filename = `${tableName ? `${tableName}_` : ''}${columnName}_${Date.now()}.${media.label.toLowerCase()}`;
    const link = document.createElement('a');
    link.href = media.displayUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  if (!isOpen) return null;

  const byteText = formatByteSize(media.approxByteLength);

  return (
    <div className="media-lightbox-backdrop" onClick={onClose}>
      <div
        className="media-lightbox-container"
        onClick={(e) => e.stopPropagation()}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {/* Top Header Bar */}
        <div className="media-lightbox-header">
          <div className="media-lightbox-title-group">
            <ImageIcon size={16} className="media-lightbox-icon" />
            <span className="media-lightbox-title">
              {tableName ? `${tableName} • ` : ''}
              {columnName}
            </span>
            <span className="media-type-badge">{media.label}</span>
            {dimensions && (
              <span className="media-dim-badge">
                {dimensions.width} × {dimensions.height} px
              </span>
            )}
            {byteText && <span className="media-size-badge">{byteText}</span>}
          </div>

          <div className="media-lightbox-header-actions">
            <button
              type="button"
              className="media-lightbox-close-btn"
              onClick={onClose}
              title="Close (Esc)"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Main Canvas Viewport Area */}
        <div
          className={`media-lightbox-viewport media-bg-${bgMode}`}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
        >
          <div
            className="media-lightbox-transform-layer"
            style={{
              transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoom}) rotate(${rotation}deg)`,
              cursor: isDragging ? 'grabbing' : zoom > 1 ? 'grab' : 'default',
            }}
          >
            <img
              ref={imgRef}
              src={media.displayUrl}
              alt={columnName}
              className="media-lightbox-img"
              referrerPolicy="no-referrer"
              draggable={false}
            />
          </div>
        </div>

        {/* Bottom Floating Control Bar */}
        <div className="media-lightbox-toolbar">
          {/* Zoom Controls */}
          <div className="media-toolbar-group">
            <button
              type="button"
              className="media-toolbar-btn"
              onClick={() => setZoom((z) => Math.max(0.2, Number((z - 0.25).toFixed(2))))}
              title="Zoom out (-)"
            >
              <ZoomOut size={15} />
            </button>
            <button
              type="button"
              className="media-toolbar-btn media-zoom-label"
              onClick={() => {
                setZoom(1);
                setPanOffset({ x: 0, y: 0 });
              }}
              title="Reset Zoom to 100% (0)"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              className="media-toolbar-btn"
              onClick={() => setZoom((z) => Math.min(5, Number((z + 0.25).toFixed(2))))}
              title="Zoom in (+)"
            >
              <ZoomIn size={15} />
            </button>
          </div>

          <div className="media-toolbar-divider" />

          {/* Rotation Controls */}
          <div className="media-toolbar-group">
            <button
              type="button"
              className="media-toolbar-btn"
              onClick={() => setRotation((r) => (r - 90 + 360) % 360)}
              title="Rotate counter-clockwise"
            >
              <RotateCcw size={15} />
            </button>
            <button
              type="button"
              className="media-toolbar-btn"
              onClick={() => setRotation((r) => (r + 90) % 360)}
              title="Rotate clockwise (R)"
            >
              <RotateCw size={15} />
            </button>
          </div>

          <div className="media-toolbar-divider" />

          {/* Background Mode Switcher */}
          <div className="media-toolbar-group">
            <button
              type="button"
              className={`media-toolbar-btn ${bgMode === 'dark' ? 'active' : ''}`}
              onClick={() => setBgMode('dark')}
              title="Sleek dark gradient background"
            >
              <span className="media-bg-icon dark-icon" />
            </button>
            <button
              type="button"
              className={`media-toolbar-btn ${bgMode === 'black' ? 'active' : ''}`}
              onClick={() => setBgMode('black')}
              title="Solid deep black background"
            >
              <span className="media-bg-icon black-icon" />
            </button>
            <button
              type="button"
              className={`media-toolbar-btn ${bgMode === 'light' ? 'active' : ''}`}
              onClick={() => setBgMode('light')}
              title="Clean light background"
            >
              <span className="media-bg-icon light-icon" />
            </button>
            <button
              type="button"
              className={`media-toolbar-btn ${bgMode === 'checkerboard' ? 'active' : ''}`}
              onClick={() => setBgMode('checkerboard')}
              title="Checkerboard pattern (for transparent PNG/SVG)"
            >
              <span className="media-bg-icon checker-icon" />
            </button>
          </div>

          <div className="media-toolbar-divider" />

          {/* Copy and Download Actions */}
          <div className="media-toolbar-group">
            <button
              type="button"
              className="media-toolbar-btn"
              onClick={handleCopyImage}
              title="Copy Image to Clipboard"
            >
              {copiedKind === 'image' ? <Check size={15} className="media-check-icon" /> : <Copy size={15} />}
              <span className="media-btn-text">
                {copiedKind === 'image' ? 'Copied' : 'Copy'}
              </span>
            </button>

            <button
              type="button"
              className="media-toolbar-btn"
              onClick={handleDownload}
              title="Download image file"
            >
              <Download size={15} />
              <span className="media-btn-text">Download</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
