/**
 * Kết nối mà editor SQL đang được focus thuộc về.
 *
 * Vì sao đây là một giá trị cấp module chứ không phải tham số, trong khi §4.1 của
 * `docs/multi-connection-plan.md` loại bỏ đúng kiểu "id ambient" đó:
 *
 * Provider của Monaco (completion, hover, go-to-definition) được đăng ký **một lần cho cả app** và
 * sống suốt vòng đời tiến trình. Chúng không nhận được `connId` tĩnh vì lúc đăng ký chưa có tab nào,
 * và không thể nhận qua tham số vì Monaco là bên gọi chúng.
 *
 * Điều khiến giá trị này **an toàn** trong khi id ambient của `dbHelper` thì không, là phạm vi kích
 * hoạt: completion và hover chỉ chạy **trong editor đang focus**, do người dùng gõ. Không có đường
 * nào chạy nền. Race mà §4.1 mô tả — hai tab refetch đồng thời rồi chèn nhau — không tồn tại ở đây,
 * vì tại một thời điểm chỉ một editor nhận phím.
 *
 * `SqlEditor` đặt giá trị này khi mount và khi editor giành focus.
 */
let focusedConnId = '';

export function setEditorConnId(connId: string): void {
  focusedConnId = connId;
}

export function editorConnId(): string {
  return focusedConnId;
}
