/**
 * Đặt vị trí menu ngữ cảnh (chuột phải) sao cho không bị tràn ra ngoài cửa sổ:
 * hết chỗ bên dưới thì lật lên trên điểm bấm, hết chỗ bên phải thì lật sang trái,
 * còn nếu menu cao/rộng hơn cả khoảng trống thì ép vào trong viewport.
 *
 * Hàm thuần để test được; phần đo kích thước thật do component làm bằng ref.
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

  // Không đủ chỗ bên phải -> mở sang trái điểm bấm
  if (left + menuWidth + margin > viewWidth) left = x - menuWidth;
  // Không đủ chỗ bên dưới -> mở lên trên điểm bấm
  if (top + menuHeight + margin > viewHeight) top = y - menuHeight;

  // Vẫn tràn (menu lớn hơn khoảng trống) -> ép vào trong viewport
  if (left + menuWidth + margin > viewWidth) left = viewWidth - menuWidth - margin;
  if (top + menuHeight + margin > viewHeight) top = viewHeight - menuHeight - margin;

  return { left: Math.max(margin, left), top: Math.max(margin, top) };
}
