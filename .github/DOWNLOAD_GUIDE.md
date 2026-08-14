# 下载指南

## 系统要求

- macOS 12 或更高版本。
- Windows 10 或更高版本。
- Linux 带有 X11 环境。

## macOS

### 手动下载

- Apple Silicon：下载 `pingyou_aarch64.dmg`
- Intel Chip：下载 `pingyou_x64.dmg`

### Homebrew 下载

1. 添加 pingyou 的 tap 源：

```bash
brew tap guipie/pingyou
```

2. 安装：

```bash
brew install --no-quarantine pingyou
```

3. 更新：

```bash
brew upgrade pingyou
```

4. 卸载：

```bash
brew uninstall --cask pingyou

brew untap guipie/pingyou
```

## Windows

- 64 位系统：下载 `pingyou_x64.exe`
- 32 位系统：下载 `pingyou_x86.exe`
- ARM64 架构：下载 `pingyou_arm64.exe`

## Linux(X11)

### 手动下载

- 64 位系统：
  - Debian / Ubuntu：下载 `pingyou_amd64.deb`
  - Fedora / RHEL：下载 `pingyou_x86_64.rpm`
  - 通用版本：下载 `pingyou_amd64.AppImage`
- ARM64 架构：
  - Debian / Ubuntu：下载 `pingyou_arm64.deb`
  - Fedora / RHEL：下载 `pingyou_aarch64.rpm`
  - 通用版本：下载 `pingyou_aarch64.AppImage`

### AUR 下载

- Manjaro / ArchLinux: `yay -S pingyou`
