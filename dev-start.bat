@echo off
set MINGW64=C:\Users\MeoMeo\AppData\Local\Microsoft\WinGet\Packages\BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\mingw64\bin
set PATH=C:\Users\MeoMeo\.cargo\bin;%MINGW64%;C:\Program Files\nodejs;%PATH%

REM Target directory outside workspace to prevent rust-analyzer from indexing/watching it
set CARGO_TARGET_DIR=C:\cargo-targets\tablegrid

echo === Rust: cargo --version ===
cargo --version
echo === CARGO_TARGET_DIR: %CARGO_TARGET_DIR% ===
echo.
echo === Starting Tauri dev ===
npm run dev
