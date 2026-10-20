# 第三方组件与许可

本项目自身以 MIT 许可发布(见 `LICENSE`)。以下是随产物分发的第三方组件及其许可,
按各自条款使用,不改变其许可。

## 运行时依赖(npm,按各自许可)

完整列表见 `pnpm-lock.yaml`。主要：

| 组件 | 许可 | 用途 |
|---|---|---|
| Electron | MIT | 桌面运行时 |
| @xterm/xterm 及 addons | MIT | 终端渲染 |
| ssh2 | MIT | SSH 协议 |
| node-pty | MIT | 伪终端 |
| keytar | MIT | 系统密钥链 |

## 打包进仓库的字体

`src/renderer/fonts/MesloLGSNerdFontMono-{Regular,Bold}.ttf`

- **Meslo LG**(上游设计,André Berg)→ Apache License 2.0
  <https://github.com/andreberg/Meslo-Font>
- **Nerd Fonts**(补丁与图标字形)→ MIT,图标字形来自多个上游图标字体(各自 OFL / MIT)
  <https://github.com/ryanoasis/nerd-fonts/blob/master/LICENSE>
- 字体文件内嵌的版权声明(`name` 表)予以保留。

如需再分发这些字体,请遵守上述许可(尤其 Apache-2.0 的 NOTICE 与 OFL 的署名要求)。

## 研究说明

本项目的设计参照了对一款商业 SSH 终端(仅本地、只读)的行为研究。
**没有**复用该产品的任何代码、二进制或资产;相关研究档案不随本仓库分发。
