import React, { useState, useEffect } from 'react';
import { type MediaInfo, formatByteSize } from '../../utils/mediaDetector';

export interface MediaHoverPopoverProps {
  media: MediaInfo;
  anchorRect: DOMRect | null;
  onClose: () => void;
  onClickExpand: () => void;
}

/**
 * Floating hover popover providing an instant, high-resolution preview of cell images.
 * Automatically positions itself relative to the anchor cell and viewport bounds.
 */
export const MediaHoverPopover: React.FC<MediaHoverPopoverProps> = ({
  media,
  anchorRect,
  onClickExpand,
}) => {
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const [hasError, setHasError] = useState(false);

  // Load natural dimensions when the image source changes
  useEffect(() => {
    // set-state-in-effect: this IS what an effect is for - loading an image is synchronising with an
    // external system, and the two resets below clear the previous image's result before the new load
    // starts. Deriving them during render is impossible: the dimensions only exist after `onload`.
    // eslint-disable-next-line react/set-state-in-effect
    setHasError(false);
    setDimensions(null);

    const img = new Image();
    img.onload = () => {
      setDimensions({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      setHasError(true);
    };
    img.src = media.displayUrl;

    return () => {
      img.onload = null;
      img.onerror = null;
    };
  }, [media.displayUrl]);

  if (!anchorRect) return null;

  // Calculate smart popover position (prefer bottom-right, fallback to top if viewport overflow)
  const popoverWidth = 260;
  const popoverHeight = 280;
  const margin = 8;

  let left = anchorRect.left;
  let top = anchorRect.bottom + margin;

  // Check right edge overflow
  if (left + popoverWidth > window.innerWidth) {
    left = Math.max(margin, window.innerWidth - popoverWidth - margin);
  }

  // Check bottom edge overflow -> flip above the anchor cell
  if (top + popoverHeight > window.innerHeight) {
    top = Math.max(margin, anchorRect.top - popoverHeight - margin);
  }

  const byteText = formatByteSize(media.approxByteLength);

  return (
    <div
      className="media-hover-popover"
      style={{ left: `${left}px`, top: `${top}px` }}
      onClick={onClickExpand}
      title="Click to open full lightbox viewer"
    >
      <div className="media-hover-img-wrapper media-checkerboard-bg">
        {hasError ? (
          <div className="media-hover-error">
            <span>Failed to load image</span>
          </div>
        ) : (
          <img
            src={media.displayUrl}
            alt={media.label}
            className="media-hover-img"
            referrerPolicy="no-referrer"
          />
        )}
      </div>

      <div className="media-hover-meta">
        <div className="media-hover-badge-group">
          <span className="media-type-badge">{media.label}</span>
          {dimensions && (
            <span className="media-dim-badge">
              {dimensions.width} × {dimensions.height}
            </span>
          )}
        </div>

        {byteText && <span className="media-size-badge">{byteText}</span>}
      </div>
    </div>
  );
};
