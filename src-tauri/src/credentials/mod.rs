//! Thông tin xác thực: nơi lấy và nơi cất.
//!
//! Ba tệp này KHÔNG dùng chung code — chúng dùng chung một mối quan tâm. Gom lại để câu hỏi
//! "app giữ bí mật ở đâu, và lấy chúng bằng cách nào" có đúng một chỗ để trả lời.

pub mod aws_iam;
pub mod oauth;
pub mod secret_store;
