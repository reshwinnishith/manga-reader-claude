"use client";

import { useCallback, useRef, useState } from "react";

export interface QuickScrubberProps {
  pageCount: number;
  currentPage: number;
  visible: boolean;
  onPageChange: (page: number) => void;
}

/**
 * Slim vertical page scrubber along the left edge.
 * Supports smooth drag-to-jump with live page position bubble on touch/pointer devices.
 * Sized with a comfortable 44px touch hit area for iPhone.
 */
export function QuickScrubber({
  pageCount,
  currentPage,
  visible,
  onPageChange,
}: QuickScrubberProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [scrubPage, setScrubPage] = useState(currentPage);
  const lastScrubbedRef = useRef(currentPage);

  const computePageFromY = useCallback(
    (clientY: number) => {
      if (!trackRef.current || pageCount <= 1) return 0;
      const rect = trackRef.current.getBoundingClientRect();
      const relativeY = Math.max(0, Math.min(clientY - rect.top, rect.height));
      const fraction = rect.height > 0 ? relativeY / rect.height : 0;
      return Math.min(pageCount - 1, Math.max(0, Math.round(fraction * (pageCount - 1))));
    },
    [pageCount],
  );

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pageCount <= 1) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // In testing environments setPointerCapture may not be implemented
    }
    setIsDragging(true);
    const targetPage = computePageFromY(e.clientY);
    setScrubPage(targetPage);
    lastScrubbedRef.current = targetPage;
    onPageChange(targetPage);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    e.preventDefault();
    e.stopPropagation();
    const targetPage = computePageFromY(e.clientY);
    setScrubPage(targetPage);
    if (targetPage !== lastScrubbedRef.current) {
      lastScrubbedRef.current = targetPage;
      onPageChange(targetPage);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // Ignore if unsupported
    }
    setIsDragging(false);
  };

  const activePage = isDragging ? scrubPage : currentPage;
  const progressRatio = pageCount > 1 ? activePage / (pageCount - 1) : 0;

  return (
    <aside
      className={`quick-scrubber ${visible ? "quick-scrubber--visible" : "quick-scrubber--hidden"}`}
      aria-hidden={!visible}
      aria-label="Page scrubber"
    >
      <div
        ref={trackRef}
        className="quick-scrubber__hit-area"
        role="slider"
        aria-label="Quick page scrubber"
        aria-valuemin={1}
        aria-valuemax={pageCount}
        aria-valuenow={activePage + 1}
        aria-valuetext={`Page ${activePage + 1} of ${pageCount}`}
        tabIndex={visible ? 0 : -1}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onKeyDown={(e) => {
          if (!visible) return;
          if (e.key === "ArrowDown" || e.key === "PageDown") {
            e.preventDefault();
            const next = Math.min(pageCount - 1, currentPage + 1);
            onPageChange(next);
          } else if (e.key === "ArrowUp" || e.key === "PageUp") {
            e.preventDefault();
            const prev = Math.max(0, currentPage - 1);
            onPageChange(prev);
          } else if (e.key === "Home") {
            e.preventDefault();
            onPageChange(0);
          } else if (e.key === "End") {
            e.preventDefault();
            onPageChange(pageCount - 1);
          }
        }}
      >
        <div className="quick-scrubber__track">
          <div
            className="quick-scrubber__thumb"
            style={{ top: `${(progressRatio * 100).toFixed(2)}%` }}
          />
        </div>

        {isDragging && (
          <div
            className="quick-scrubber__bubble"
            style={{ top: `${(progressRatio * 100).toFixed(2)}%` }}
            role="status"
            aria-live="polite"
          >
            Page {activePage + 1} / {pageCount}
          </div>
        )}
      </div>
    </aside>
  );
}
