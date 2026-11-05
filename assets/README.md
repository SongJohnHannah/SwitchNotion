# Switch Notion 个人图标

- `switch-notion.png`：以 Notion 为主体，小熊保持收瘦后的身形并适度放大，耳顶接近 N 字右上方横笔，坐在右下角吃缺口碎片。
- `switch-notion-settings.png`：同样以 Notion 为主体，小熊作为陪衬，坐着向缺口安装齿轮。
- `notion.ico` / `notion.icns`：主入口的 Windows / Mac 多尺寸导出。
- `notion-settings.ico` / `notion-settings.icns`：配置入口的 Windows / Mac 多尺寸导出。

图像通过内置 image_gen 生成。导出仅缩放和封装格式，不改变已确认的图案或透明背景：

```powershell
powershell.exe -NoProfile -File scripts/build-app-icons.ps1 -Source assets/switch-notion.png -BaseName notion -RuntimePng src/app-icon.png
powershell.exe -NoProfile -File scripts/build-app-icons.ps1 -Source assets/switch-notion-settings.png -BaseName notion-settings -RuntimePng src/settings/app-icon.png
```
