# OneBot 11 / NapCat 接入模块

- `transport.js`：连接、握手、心跳、重连、API 调用与入站归一化调度。
- `wire.js`：消息段与文本/媒体转换、事件归一化、retcode 分类与引用失效判定。
- `napcat-control.js`：宿主状态、登录二维码、启停脚本与 WebUI 链接。

这些模块随插件一同发布。共享模块通过动态 import 加载，协议模块或宿主控制不可用时只影响对应功能。`scripts/check-isolation.mjs` 检查该模块边界；安装与线路配置见项目 README。
