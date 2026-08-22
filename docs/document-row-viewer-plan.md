# Thiết kế & Kế hoạch Triển khai: Document / Row Viewer Modal (Phong cách Studio 3T)

## 1. Mục đích & Bối cảnh
Khi làm việc với các bảng cơ sở dữ liệu có nhiều cột, hoặc các dòng chứa văn bản dài, dữ liệu JSON, UUID, timestamp..., việc xem và chỉnh sửa trên từng ô của lưới bảng (`DataGrid` / `SqlEditor`) thường bị cắt ngắn (`ellipsis`), phải cuộn ngang liên tục và khó quan sát toàn bộ cấu trúc dữ liệu của một bản ghi.

Tính năng **Document / Row Viewer Modal** được thiết kế theo phong cách của **Studio 3T**, **TablePlus** và **DBeaver**, mang lại trải nghiệm xem và chỉnh sửa bản ghi chuyên sâu, trực quan và tiện lợi.

---

## 2. Kiến trúc & Các Chế độ Xem (View Modes)

### 2.1. 📑 Table / Form View (Field Inspector)
* **Hiển thị:** Bảng 3 cột gồm `Tên trường (Column)` — `Kiểu dữ liệu (Type)` — `Giá trị (Value)`.
* **Bộ lọc nhanh:** Ô tìm kiếm (Filter fields) giúp tìm nhanh tên cột trong các bảng có từ 20 đến 100+ cột.
* **Tương tác:**
  * Hiển thị toàn bộ nội dung giá trị không bị truncate / ellipsis.
  * Hỗ trợ chỉnh sửa trực tiếp giá trị từng ô (Inline Edit).
  * Nút Copy nhanh giá trị của từng field (`Copy Field Value`).
  * Phân biệt rõ trạng thái `NULL`, chuỗi rỗng `""`, boolean, number và object.

### 2.2. 🌳 Tree View (Dạng cây phân cấp)
* **Mục đích:** Hỗ trợ cực tốt cho các cột chứa dữ liệu JSON lồng nhau (Nested Objects / Arrays) hoặc toàn bộ document.
* **Cấu trúc:** Mỗi node thể hiện:
  * Khóa / Chỉ mục (`key / index`)
  * Nhãn kiểu dữ liệu (`String`, `Number`, `Boolean`, `Array[n]`, `Object{n}`, `Null`)
  * Giá trị tương ứng.
* **Tiện ích:** Nút `Expand All` (Mở rộng tất cả) và `Collapse All` (Thu gọn tất cả), hỗ trợ copy đường dẫn JSON path (ví dụ: `address.city`).

### 2.3. 📝 JSON Editor / Code View
* **Trình hiển thị:** Tích hợp Monaco Editor với syntax highlight JSON.
* **Tiện ích:**
  * **Beautify / Format JSON:** Tự động căn chỉnh thụt lề 2 spaces.
  * **Minify JSON:** Nén JSON về 1 dòng duy nhất.
  * **Copy JSON:** Sao chép toàn bộ bản ghi JSON vào Clipboard.
  * **Chỉnh sửa & Đồng bộ:** Cho phép người dùng chỉnh sửa JSON trực tiếp, kiểm tra tính hợp lệ (JSON Valid) và áp dụng thay đổi ngược lại dữ liệu dòng.

---

## 3. Bộ điều hướng bản ghi (Sequential Navigation)
* **Header Modal:** Hiển thị vị trí dòng hiện tại: `users — Dòng 27 / 100` (kèm thông tin Khóa chính nếu có).
* **Nút điều hướng:**
  * `◀ Trước (Prev)`: Chuyển sang xem bản ghi liền trước mà không cần đóng modal (Phím tắt: `Alt + Left` hoặc `Ctrl + [`).
  * `Sau ▶ (Next)`: Chuyển sang xem bản ghi tiếp theo (Phím tắt: `Alt + Right` hoặc `Ctrl + ]`).
* **Trạng thái:** Tự động disable khi ở đầu hoặc cuối danh sách.

---

## 4. Các điểm kích hoạt (Trigger Points)
1. **Chuột phải trên ô/dòng:** Menu ngữ cảnh hiển thị thêm mục `🔍 Xem chi tiết dòng (Document Viewer) [Space]`.
2. **Nhấp đúp vào cột STT / Row Header:** Mở ngay Document Viewer cho dòng đó.
3. **Phím tắt:** Bấm phím `Space` khi một dòng đang được chọn (selected row).
4. **Quick Look Button:** Nút kính lúp trên thanh công cụ / ô xem nhanh.

---

## 5. Quy chuẩn Kỹ thuật & Styling
* **CSS:** Tuân thủ tuyệt đối quy tắc của dự án trong `AGENTS.md` — **100% sử dụng CSS Classes** định nghĩa trong `src/index.css`, không dùng inline styles (trừ các tọa độ hoặc thuộc tính runtime).
* **i18n:** Đầy đủ bản dịch trong 3 ngôn ngữ: Tiếng Việt (`vi.ts`), Tiếng Anh (`en.ts`), Tiếng Nhật (`ja.ts`).
* **Component độc lập:** `src/components/RowDocumentModal.tsx` để có thể tái sử dụng cho cả `DataGrid` (Table Viewer) lẫn `SqlEditor` (Query Results).
