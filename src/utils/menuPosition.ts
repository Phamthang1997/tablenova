/**
 * Places a (right-click) context menu so that it never spills outside the window: with no room
 * below it flips above the click point, with no room to the right it flips to the left, and when the
 * menu is taller or wider than the space itself it is clamped into the viewport.
 *
 * A pure function so it can be tested; measuring the real size is the component's job, via a ref.
 */
export interface MenuRect {
  top: number;
  left: number;
}

export function clampMenu(
  x: number,
  y: number,
  menuWidth: number,
  menuHeight: number,
  viewWidth: number,
  viewHeight: number,
  margin = 8
): MenuRect {
  let left = x;
  let top = y;

  // Not enough room on the right -> open to the left of the click point
  if (left + menuWidth + margin > viewWidth) left = x - menuWidth;
  // Not enough room below -> open above the click point
  if (top + menuHeight + margin > viewHeight) top = y - menuHeight;

  // Still spilling (the menu is larger than the space) -> clamp it into the viewport
  if (left + menuWidth + margin > viewWidth) left = viewWidth - menuWidth - margin;
  if (top + menuHeight + margin > viewHeight) top = viewHeight - menuHeight - margin;

  return { left: Math.max(margin, left), top: Math.max(margin, top) };
}
