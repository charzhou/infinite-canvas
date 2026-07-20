# xAI 视频渠道设计

## 目标

在现有渠道配置中新增 `xAI` 协议，使视频工作台和画布的视频生成可直接调用 xAI Imagine 视频 API。

## 配置

- 在渠道协议选择中增加 `xAI`。
- `xAI` 的默认 Base URL 为 `https://api.x.ai`。
- 用户在渠道中添加 `grok-imagine-video` 或 `grok-imagine-video-1.5` 等视频模型，并正常指定为视频能力。
- 现有 OpenAI、Gemini、Seedance 和自定义模型脚本行为不变。

## 调用流程

1. 对 `xAI` 视频模型，提交 JSON 到 `POST /v1/videos/generations`。
2. 请求包含 `model`、`prompt`、`duration`、`aspect_ratio` 和 `resolution`；有首帧图时使用 `image`，多张参考图时使用 `reference_images`。
3. 从响应取得 `request_id`，每 5 秒查询 `GET /v1/videos/{request_id}`。
4. 返回状态为 `done` 时读取 `video.url`，并沿用现有逻辑下载后保存到浏览器本地媒体存储。
5. `failed` 和 `expired` 作为失败状态返回；其他状态继续轮询。

## 参数与边界

- 时长收敛到 xAI 支持的 1 到 15 秒。
- 比例使用已有比例设置，映射到 xAI 的 `aspect_ratio`。
- 分辨率使用已有清晰度设置，映射到 xAI 的 `resolution`；`1080p` 是否可用由 xAI 模型和图生视频模式决定，服务端拒绝时显示原始错误。
- 视频和音频参考资产不传给 xAI，仍要求使用 Seedance；xAI 仅支持文本、首帧图和参考图生成。

## 错误与恢复

任务日志保存 provider、模型和任务 ID，因此刷新页面后可继续按原渠道轮询。xAI 返回的临时 URL 会在完成后立即下载保存，避免签名 URL 过期影响历史记录。
