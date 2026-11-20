# Notion 图片和视频直连加速

Windows x64 可在“登录与网络”开启“图片和视频直连加速”。页面中的图片、图片搜索预览、视频播放和拖动进度使用媒体线路。Notion 签发上传地址、验证上传结果和写入页面使用原有网络。通过官方 API 上传时，只有发送图片或视频文件数据的请求使用媒体线路。网页、登录、页面同步、选区弹框和普通 API 继续使用系统网络。

Switch Notion 在后台探测媒体域名的公网地址。识别出的媒体请求由 Caddy 使用选出的地址和物理网卡转发。HTTPS 仍由客户端验证原站。可用的直连在传输期间会继续使用。服务器拒绝、连接断开或直连连续 15 秒无网络活动时，受影响的媒体会回到系统网络。回退的视频长范围请求可以分段读取，每段须匹配文件标识和字节范围。上传回退时沿用原有签名或上传编号。Windows 使用文件名为 `caddy` 的原生组件，由 `src/notion-smart-native.ps1` 启动，组件位于 `.notion-switch/caddy-route/windows-amd64/caddy`。

如果源码副本没有这个组件，可安装 Go 后在联网环境执行 `node scripts/build-notion-caddy.mjs`。构建脚本固定 xcaddy 0.4.7、Caddy 2.11.7 和 caddy-l4 0.1.3，输出不带后缀的 Caddy 文件；构建完成后，在设置中开启并重启应用。构建时请先退出使用该组件的 Switch Notion。

## Apple Silicon 接口

Mac 接入可复用 `src/notion-media-transfer.cjs` 的按请求分流，以及 `src/notion-smart-service.cjs` 的 Caddy 生命周期。`src/notion-smart-launch.cjs` 根据系统和架构查找 `darwin-arm64/caddy`。Mac 的启动器、网络接口选择、休眠唤醒和实际上传、播放路径仍需在 Apple Silicon 上适配并验证。
