<p align="center">
  <img src="app/src/main/res/mipmap-xxxhdpi/ic_launcher.png" width="128" height="128" alt="TapSulor">
</p>

<h1 align="center">TapSulor</h1>

<p align="center">
  <strong>TapTap 开发者收入统计助手 — Android 端</strong>
</p>

<p align="center">
  📱 <strong>Android</strong>（本仓库） &nbsp;·&nbsp; 💻 <strong>Windows 电脑版</strong> &nbsp;·&nbsp; 🍎 <strong>iOS</strong>
</p>

<p align="center">
  <a href="https://github.com/liusu239113/TapSulor-Android/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/license-GPL%203.0-blue.svg" alt="License">
  </a>
  <img src="https://img.shields.io/badge/Android-14%2B-brightgreen" alt="Android">
  <img src="https://img.shields.io/badge/Kotlin-Jetpack%20Compose-purple" alt="Kotlin">
</p>

---

## 📥 下载

| 平台 | 下载地址 | 说明 |
|---|---|---|
| 📱 **Android** | [最新 Releases](https://github.com/liusu239113/TapSulor-Android/releases) · [下载站](https://ark.yanyususu.online/tapsulor/) | APK 安装包，Android 14+ |
| 💻 **Windows 电脑版** | **[安装版 Setup（推荐）](https://github.com/liusu239113/TapSulor-Desktop/releases/download/latest/TapSulor-Setup-1.0.3-x64.exe)**<br>**[便携版 Portable（免安装）](https://github.com/liusu239113/TapSulor-Desktop/releases/download/latest/TapSulor-Portable-1.0.3-x64.exe)** | 源码与全部版本：[TapSulor-Desktop](https://github.com/liusu239113/TapSulor-Desktop) · [Desktop Releases](https://github.com/liusu239113/TapSulor-Desktop/releases) |
| 🍎 **iOS** | [源码仓库](https://github.com/liusu239113/TapSulor-iOS) | **不提供 IPA**，需在 Mac 上用 Xcode 自行编译签名，见下方说明 |

> 💻 **关于电脑版**：由 `TapSulor-Desktop` 仓库 main 分支自动构建，标记为开发版（Pre-release）。安装版会自动创建开始菜单和桌面快捷方式；便携版免安装，双击即用。
>
> 🍎 **关于 iOS**：目前只提供源代码工程（Swift + Xcode），没有可直接安装的 IPA。iOS 应用必须在 macOS + Xcode 环境下编译，并用自己的 Apple ID / 开发者 Team 签名，无法在 Windows 或手机上直接打包。

---

## 📱 简介

**TapSulor** 是一款专为 TapTap 开发者打造的移动端收入统计工具。  
无需打开电脑，随时随地查看你的应用收入与下载数据，轻松掌握运营动态。

## ✨ 功能

- 📊 **收入概览** — 一目了然查看总收入、月度收入趋势
- 📥 **下载统计** — 实时查看各应用的下载量变化
- 🔔 **更新检查** — 启动自动检测，发现新版本即时弹窗提示
- 🎨 **像素风格** — 复古像素风 UI，清爽不油腻
- 🌐 **下载站** — 配套在线下载站，快速获取最新版本

## 🛠️ 构建

```bash
# 克隆仓库
git clone https://github.com/liusu239113/TapSulor-Android.git
cd TapSulor-Android

# 使用 Gradle 构建 Release APK
./gradlew assembleRelease
```

APK 输出路径：`app/build/outputs/apk/release/`

## 📄 开源协议

本项目采用 **GNU General Public License v3.0** — 详见 [LICENSE](LICENSE) 文件。

---

<p align="center">
  开发者：<strong>流苏水寒</strong>
  <br>
  联系 QQ：<a href="https://qm.qq.com/q/2391130219">2391130219</a>
  <br><br>
  <sub>如果觉得有用，欢迎 ⭐ Star 支持！</sub>
</p>
