<!--
Các kiểm tra tự động (rustfmt, clippy, oxlint, tsc, test) do CI đảm nhiệm.
Quy ước code chi tiết: xem CONTRIBUTING.md
-->

## Mô tả

<!-- Thay đổi gì và vì sao cần thay đổi. 2–5 câu, viết dưới góc nhìn người dùng hoặc sản phẩm. -->

## Loại thay đổi

* [ ] Feature
* [ ] Bugfix
* [ ] Refactor / cleanup
* [ ] Performance
* [ ] Build / CI / dependency
* [ ] Docs

## Issue liên quan

Closes #

## Thay đổi chính

<!-- Gạch đầu dòng theo module hoặc theo hành vi. Không liệt kê từng file. -->

*
*
*

## Quyết định kỹ thuật

<!-- Chỉ điền khi có đánh đổi, phương án đã cân nhắc rồi loại bỏ, hoặc giới hạn đã biết. Không có thì ghi "Không có". -->

*

## Kiểm thử

**Đã kiểm thử:**

* [ ] Luồng chính
* [ ] Dữ liệu rỗng hoặc không hợp lệ
* [ ] Trường hợp lỗi
* [ ] Regression các chức năng liên quan

**Cách kiểm thử lại:**

1.
2.
3.

## Ảnh hưởng & rủi ro

* **Breaking change:** không / có →
* **Migration, đổi schema, config hoặc env:** không / có →
* **Cần rebuild native hoặc bump version app:** không / có
* **Cách rollback nếu lỗi:**

## Ảnh chụp màn hình

<!-- Chỉ khi có thay đổi giao diện. Không có thì xoá cả mục này. -->

| Trước | Sau |
| ----- | --- |
|       |     |

## Checklist

* [ ] CI xanh (format, lint, type check, test)
* [ ] Đã tự đọc lại toàn bộ diff
* [ ] Đã thêm hoặc cập nhật test cho phần thay đổi
* [ ] Đã cập nhật tài liệu hoặc doc comment nếu hành vi thay đổi
* [ ] Không còn debug code, `console.log`, `unwrap()` tạm hoặc TODO bỏ sót
* [ ] Không chứa secret, token hoặc thông tin nhạy cảm

## Ghi chú cho reviewer

<!-- Phần nào cần đọc kỹ, phần nào chỉ là di chuyển code, phần nào cần thêm ý kiến. -->

*