@echo off
chcp 65001 >nul
title Tauri 深度清理工具

echo ===================================================
echo     警告：正在执行 Tauri 项目【深度彻底清理】
echo   这将删除所有缓存、依赖、数据库和锁文件！
echo ===================================================
echo.
pause

echo [1/8] 正在清理前端缓存与构建产物...
if exist "node_modules" rmdir /s /q "node_modules"
if exist "dist" rmdir /s /q "dist"
if exist ".next" rmdir /s /q ".next"
if exist "build" rmdir /s /q "build"
if exist ".vite" rmdir /s /q ".vite"
if exist ".turbo" rmdir /s /q ".turbo"

echo [2/8] 正在清理依赖锁文件 (防止缓存损坏)...
if exist "package-lock.json" del /f /q "package-lock.json"
if exist "pnpm-lock.yaml" del /f /q "pnpm-lock.yaml"
if exist "yarn.lock" del /f /q "yarn.lock"
if exist "bun.lockb" del /f /q "bun.lockb"

echo [3/8] 正在清理 pnpm 存储缓存...
if exist ".pnpm-store" rmdir /s /q ".pnpm-store"

echo [4/8] 正在清理 Tauri 缓存与配置...
if exist "src-tauri\.tauri" rmdir /s /q "src-tauri\.tauri"
if exist "src-tauri\target" rmdir /s /q "src-tauri\target"
if exist "src-tauri\Cargo.lock" del /f /q "src-tauri\Cargo.lock"
if exist "src-tauri\gen" rmdir /s /q "src-tauri\gen"

echo [5/8] 正在清理 Rust 全局缓存...
if exist "%USERPROFILE%\.cargo\registry" (
    echo   清理 Cargo 注册表缓存...
    rmdir /s /q "%USERPROFILE%\.cargo\registry"
)
if exist "%USERPROFILE%\.cargo\git" (
    echo   清理 Cargo Git 缓存...
    rmdir /s /q "%USERPROFILE%\.cargo\git"
)

echo [6/8] 正在清理应用数据库文件...
if exist "%APPDATA%\com.guipie.Pingyou" (
    echo   清理应用数据目录...
    rmdir /s /q "%APPDATA%\com.guipie.Pingyou"
)
if exist "%LOCALAPPDATA%\com.guipie.Pingyou" (
    echo   清理本地应用数据...
    rmdir /s /q "%LOCALAPPDATA%\com.guipie.Pingyou"
)
if exist "*.db" del /f /q "*.db"
if exist "*.sqlite" del /f /q "*.sqlite"
if exist "*.sqlite3" del /f /q "*.sqlite3"

echo [7/8] 正在清理系统临时文件与日志...
if exist "%TEMP%\tauri*" del /f /q "%TEMP%\tauri*"
if exist "%TEMP%\com.guipie.Pingyou*" del /f /q "%TEMP%\com.guipie.Pingyou*"
if exist "*.log" del /f /q "*.log"
if exist ".eslintcache" del /f /q ".eslintcache"
if exist ".stylelintcache" del /f /q ".stylelintcache"

echo [8/8] 正在自动重装前端依赖并全新启动...
if exist "pnpm-workspace.yaml" (
    goto pnpm_run
) else (
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
echo.
echo ===================================================
echo     深度清理完成！应用正在重新启动...
echo ===================================================
pause