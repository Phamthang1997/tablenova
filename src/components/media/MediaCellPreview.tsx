import React, { useState, useRef, useMemo, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { Image as ImageIcon, Eye } from 'lucide-react';
import { detectMedia, type MediaInfo } from '../../utils/mediaDetector';
import { MediaHoverPopover } from './MediaHoverPopover';
import { MediaViewerModal } from './MediaViewerModal';

export interface MediaCellPreviewProps {
  value: any;
  columnName?: string;
  tableName?: string;
  fallbackText?: React.ReactNode;
}

/**
 * Smart Cell Component that preserves the original cell text content
 * while adding a compact, interactive image preview button on the right.
 */
export const MediaCellPreview: React.FC<MediaCellPreviewProps> = React.memo(({
  value,
  columnName = '',
  tableName,
  fallbackText,
}) => {
  // Derived, not state: `detectMedia` is a pure function of the two props, so a state + effect pair
  // only bought an extra render on every cell whose value changed - and a grid changes a lot of them
  // at once.
  const mediaInfo: MediaInfo | null = useMemo(
    () => detectMedia(value, columnName),
    [value, columnName],
  );

  const [isHovered, setIsHovered] = useState<boolean>(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  // Which URL failed to load, rather than a bare "it failed" flag.
  //
  // The flag needed an effect to clear it when the cell's value changed; remembering WHAT failed
  // makes that automatic - a new `displayUrl` simply is not the failed one. Two values that resolve
  // to the same URL keep the error, which is right: same URL, same failure.
  const [erroredUrl, setErroredUrl] = useState<string | null>(null);
  const thumbError = erroredUrl !== null && erroredUrl === mediaInfo?.displayUrl;
  const hoverTimeoutRef = useRef<any>(null);
  const previewBtnRef = useRef<HTMLButtonElement>(null);

  const handleMouseEnter = useCallback(() => {
    if (!mediaInfo) return;
    hoverTimeoutRef.current = setTimeout(() => {
      if (previewBtnRef.current) {
        setAnchorRect(previewBtnRef.current.getBoundingClientRect());
        setIsHovered(true);
      }
    }, 150);
  }, [mediaInfo]);

  const handleMouseLeave = useCallback(() => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
    }
    setIsHovered(false);
  }, []);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setIsHovered(false);
    setIsModalOpen(true);
  }, []);

  const textContent = fallbackText !== undefined ? fallbackText : String(value ?? '');

  if (!mediaInfo) {
    return <>{textContent}</>;
  }

  return (
    <>
      <div className="media-cell-wrapper">
        <span className="media-cell-text" title={typeof value === 'string' ? value : undefined}>
          {textContent}
        </span>

        <button
          ref={previewBtnRef}
          type="button"
          className="media-cell-preview-btn media-checkerboard-bg"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          onClick={handleClick}
          title="Hover to preview / Click to view full image"
        >
          {thumbError ? (
            <ImageIcon size={11} className="media-cell-fallback-icon" />
          ) : (
            <img
              src={mediaInfo.displayUrl}
              alt={mediaInfo.label}
              className="media-cell-thumb-img"
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={() => setErroredUrl(mediaInfo.displayUrl)}
            />
          )}
          <div className="media-cell-hover-overlay">
            <Eye size={9} />
          </div>
        </button>
      </div>

      {/* Hover Quick Preview Popover rendered into document.body to avoid table overflow clipping */}
      {isHovered && anchorRect && typeof document !== 'undefined' && ReactDOM.createPortal(
        <MediaHoverPopover
          media={mediaInfo}
          anchorRect={anchorRect}
          onClose={() => setIsHovered(false)}
          onClickExpand={() => {
            setIsHovered(false);
            setIsModalOpen(true);
          }}
        />,
        document.body
      )}

      {/* Full Lightbox Viewer Modal rendered into document.body */}
      {isModalOpen && typeof document !== 'undefined' && ReactDOM.createPortal(
        <MediaViewerModal
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          media={mediaInfo}
          columnName={columnName}
          tableName={tableName}
        />,
        document.body
      )}
    </>
  );
});
