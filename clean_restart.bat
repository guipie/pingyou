@echo off
chcp 65001 >nul
title Tauri 深度清理工具

echo ===================================================
echo     警告：正在执行 Tauri 项目【深度彻底清理】
echo   这将删除所有缓存、依赖和锁文件，并重新完全编译！
echo ===================================================
echo.
pause

echo [1/5] 正在清理前端缓存与构建产物...
if exist "node_modules" rmdir /s /q "node_modules"
if exist "dist" rmdir /s /q "dist"
if exist ".next" rmdir /s /q ".next"
if exist "build" rmdir /s /q "build"

echo [2/5] 正在清理依赖锁文件 (防止缓存损坏)...
if exist "package-lock.json" del /f /q "package-lock.json"
if exist "pnpm-lock.yaml" del /f /q "pnpm-lock.yaml"
if exist "yarn.lock" del /f /q "yarn.lock"
if exist "bun.lockb" del /f /q "bun.lockb"

echo [3/5] 正在清理 Tauri 缓存...
if exist "src-tauri\.tauri" rmdir /s /q "src-tauri\.tauri"

echo [4/5] 正在强制清理 Rust 编译缓存...
if exist "src-tauri\target" rmdir /s /q "src-tauri\target"
if exist "src-tauri\Cargo.lock" del /f /q "src-tauri\Cargo.lock"

echo [5/5] 正在自动重装前端依赖并全新启动...
:: 检测包管理器并执行（默认回退到 npm）
if exist "pnpm-workspace.yaml" (
    goto pnpm_run
) else (
    :: 根据之前遗留的文件痕迹或环境变量猜测，优先推荐你常用的包管理器
    :: 这里默认使用 npm，如果你用其他工具可以手动修改下方逻辑
    goto npm_run
)

:pnpm_run
echo 检测到 pnpm 环境，正在全新安装并启动...
call pnpm install
call pnpm tauri dev
goto end

:npm_run
echo 正在使用 npm 全新安装依赖并启动...
call npm install
call npm run tauri dev
goto end

:end
echo 运行结束。
pause
