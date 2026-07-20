# Task 1 Report: xAI 渠道协议配置

## 修改

- `ApiCallFormat` 新增 `xai`。
- xAI 默认接口地址为 `https://api.x.ai`。
- 持久化配置规范化时保留 `xai` 协议值。
- 渠道编辑器协议选择新增 `xAI`。

## 验证

- `git diff --check` 通过。
- `npm run typecheck --prefix web` 未能完成：本机 pnpm 全局 TypeScript 路径缺失，Node 无法加载 `typescript/bin/tsc`。

## 范围

- 未修改视频服务或其他无关文件。

## 审查修复

- 修复 `web/src/components/layout/app-config-modal.tsx` 中的 `apiFormatLabel`：`xai` 现在显示为 `xAI`，`gemini` 与其他现有值的显示保持不变。
- 执行命令：`git diff --check`
- 结果：通过，无空白错误。
- 提交说明：`fix: label xAI api format`。
