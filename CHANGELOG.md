# Changelog

## [0.2.0](https://github.com/TinggalLeaf/irctl-desktop/compare/v0.1.1...v0.2.0) (2026-08-11)


### Features

* **ci:** 合并 Release PR 后自动接力全平台构建发布（不再依赖 tag push 事件） ([38fa30a](https://github.com/TinggalLeaf/irctl-desktop/commit/38fa30aa8505afed8891348762e31aeec20cddea))
* 跨平台红外工具箱首个版本 ([4d5e9a0](https://github.com/TinggalLeaf/irctl-desktop/commit/4d5e9a01d124da4880554a2606cfa64d79cc15db))


### Bug Fixes

* **ci:** Linux arm64 AppImage 打包补充 xdg-utils ([25aae8e](https://github.com/TinggalLeaf/irctl-desktop/commit/25aae8e5362b01c7d832f5a613949c546a889d79))
* **ci:** Linux 构建补充 libudev-dev/pkg-config 依赖 ([c3e4cda](https://github.com/TinggalLeaf/irctl-desktop/commit/c3e4cdaab2a25626b93214e50a8cf5dcf43e008d))
* **ci:** macOS x64 改为在 Apple Silicon runner 交叉编译，弃用排队缓慢的 macos-13 ([77223f4](https://github.com/TinggalLeaf/irctl-desktop/commit/77223f435544febaa283557f49ad5edfff2f9fd6))
* **ci:** pnpm-workspace.yaml 补充 packages 字段 ([5a313c2](https://github.com/TinggalLeaf/irctl-desktop/commit/5a313c248e10b7a0afcef2fa762b0adbaf360878))
* **ci:** Release 构建改在新 tag 引用上派发运行（GITHUB_TOKEN 仅在 tag ref 运行中可上传资产） ([bfd8372](https://github.com/TinggalLeaf/irctl-desktop/commit/bfd8372d5efa7cd604fe82e0b3f42b08bf4a253c))
* **ci:** 上传资产改用 gh release upload（GITHUB_TOKEN 跨运行 PATCH Release 必 403）；移除探针工作流 ([7dce817](https://github.com/TinggalLeaf/irctl-desktop/commit/7dce817668acc4007ad0c9ab76b7fd09fb123fba))
* 修复学习收不到信号；新增实时红外页；学习默认软件模式 ([e7abd90](https://github.com/TinggalLeaf/irctl-desktop/commit/e7abd90b9642157acdad7f553f569aa1abdb8ecb))
* 重构串口帧解析兼容无前缀应答；实时红外改股票式联动大图 ([39eaa16](https://github.com/TinggalLeaf/irctl-desktop/commit/39eaa16839bbfec0b3aa9c193eab5a098beb6bd3))

## [0.1.1](https://github.com/TinggalLeaf/irctl-desktop/compare/v0.1.0...v0.1.1) (2026-08-11)


### Bug Fixes

* 修复学习收不到信号；新增实时红外页；学习默认软件模式 ([e7abd90](https://github.com/TinggalLeaf/irctl-desktop/commit/e7abd90b9642157acdad7f553f569aa1abdb8ecb))
* 重构串口帧解析兼容无前缀应答；实时红外改股票式联动大图 ([39eaa16](https://github.com/TinggalLeaf/irctl-desktop/commit/39eaa16839bbfec0b3aa9c193eab5a098beb6bd3))
