/**
 * Đặt position menu ngữ cảnh (right click / context menu) sao for not is tràn ra ngoài window:
 * hết chỗ bên under thì lật lên on điểm bấm, hết chỗ bên must thì lật sang trái,
 * còn if menu cao/rộng hơn cả khoảng trống thì ép ando in viewport.
 *
 * Hàm thuần to test is; phần đo size thật do component ism bằng ref.
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

  // not đủ chỗ bên must -> open sang trái điểm bấm
  if (left + menuWidth + margin > viewWidth) left = x - menuWidth;
  // not đủ chỗ bên under -> open lên on điểm bấm
  if (top + menuHeight + margin > viewHeight) top = y - menuHeight;

  // Vẫn tràn (menu lớn hơn khoảng trống) -> ép ando in viewport
  if (left + menuWidth + margin > viewWidth) left = viewWidth - menuWidth - margin;
  if (top + menuHeight + margin > viewHeight) top = viewHeight - menuHeight - margin;

  return { left: Math.max(margin, left), top: Math.max(margin, top) };
}
