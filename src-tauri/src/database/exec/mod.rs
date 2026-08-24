//! Ba funnel thực thi SQL. Cùng một thân hàm chạy dù connection đến từ pool hay từ
//! phiên transaction đã được pin — xem `tx.rs`.

pub mod bound;
pub mod raw;
pub mod stream;
