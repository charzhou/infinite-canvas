# Task 2 Report: xAI 视频创建和轮询

## 修改

- `VideoGenerationTask.provider` 新增 `xai`，创建和恢复轮询路径会分派到 xAI 实现。
- xAI 使用 JSON 提交 `POST /v1/videos/generations`，包含模型、提示词、1-15 秒时长、分辨率、可选比例和参考图片。
- 单张参考图发送为 `image.url`，多张发送为 `reference_images`；本地参考图通过 `imageToDataUrl` 转换，已有公网或 data URL 保持原值。
- xAI 使用 `GET /v1/videos/{request_id}` 轮询；`done` 读取 `video.url`，`failed` 和 `expired` 返回中文错误。
- xAI 不支持参考视频或参考音频时会在提交前提示移除。
- 现有尺寸映射为 xAI 支持的比例，`auto` 不提交 `aspect_ratio`。

## 验证

- `git diff --check` 通过。
- `node --check web/src/services/api/video.ts` 通过语法检查。
- `npm run typecheck --prefix web` 未能运行：本机 pnpm 全局 TypeScript 路径缺失，Node 无法加载 `typescript/bin/tsc`。

## Review 修复：xAI 轮询间隔

### 修改

- `web/src/services/api/video.ts`：`requestVideoGeneration` 中 xAI 与 Seedance 一样使用 5000ms 轮询间隔；OpenAI 和插件任务仍为 2500ms。
- `web/src/pages/video/index.tsx`：持久化生成日志恢复后的 `pollGenerationLog` 中，xAI 与 Seedance 一样使用 5000ms 轮询间隔。

### 验证

- `git diff --check`：通过（退出码 0）。
- `npm run typecheck --prefix web`：未能运行（退出码 1）；Node 无法找到 `/Users/charilezhou/Library/pnpm/global/5/.pnpm/typescript@5.8.3/node_modules/typescript/bin/tsc`。

## 范围

- 原始 xAI 视频支持改动仅修改 `web/src/services/api/video.ts`；本次 review 修复还修改了 `web/src/pages/video/index.tsx`，以覆盖持久化任务恢复路径。
- 未改动既有 OpenAI、Seedance 或插件视频请求行为。
