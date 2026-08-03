# Sub2API 渠道链接导入设计

## 目标

提供一个入口页，让用户打开携带 Sub2API API Key 和渠道描述符的链接后，自动验证 API Key、拉取可用模型，并创建或更新对应的手动渠道，无需进入配置弹窗。

## 范围

- 新增 `/connect/sub2api` 路由和入口页。
- 网关地址固定为应用配置的 Sub2API 网关地址，链接不可覆盖。
- 支持 `apiKey` 与 `channel` 两个参数；`channel` 是 base64url 编码的 JSON 描述符。
- 以 `channelId` 为手动渠道的唯一覆盖键：已有同 ID 手动渠道更新，不存在则新增。
- 保留已有 OIDC 渠道和其他手动渠道。

不在本次范围内：服务端兑换码、链接签发、跨设备同步和任意第三方网关。

## 链接契约

```text
/connect/sub2api?apiKey=<Sub2API API Key>&channel=<base64url JSON>
```

描述符：

```json
{
  "channelId": "sub2api-tenant-a",
  "name": "Tenant A",
  "models": [
    { "name": "gpt-5.6-terra", "capability": "text" },
    { "name": "grok-imagine-video", "capability": "video", "apiFormat": "xai" }
  ],
  "defaults": {
    "text": "gpt-5.6-terra",
    "video": "grok-imagine-video"
  }
}
```

`channelId` 必须是非空、受限字符集的渠道 ID。`name`、模型能力、模型协议和默认模型均按明确 schema 校验。链接不得传入 `baseUrl`、`authMode`、`providerId`、脚本、请求头或其他配置字段。

## 导入流程

1. 入口页读取 query，立刻从地址栏清除 `apiKey` 与 `channel`，再执行异步操作。
2. 校验 API Key 和渠道描述符；无效时展示失败状态，绝不持久化 Key。
3. 使用固定 Sub2API 网关和 API Key 调用 `GET /v1/models`。
4. 仅接受网关返回的模型。描述符的模型列表提供能力、协议与排序提示，最终模型集合取其与返回模型的交集；未提供描述符模型时使用全部返回模型和现有能力推断。
5. 校验每个默认模型都在最终模型集合中；否则导入失败。
6. 以 `channelId` 查找同 ID 的手动渠道。找到则替换其 API Key、名称和模型；否则创建新渠道。固定写入 `providerId: "sub2api"` 以保留 Sub2API 视频适配。
7. 使用现有渠道归一化逻辑更新模型选项和默认选择，并跳转首页。

OIDC 渠道不参与匹配，也不会被入口页替换。若同 ID 的现有渠道是 OIDC，导入失败并提示更换 `channelId`。

## 安全与失败处理

- API Key 不写日志、不回显，也不包含在错误信息中。
- URL 清理发生在模型请求之前；这降低页面内泄露风险，但 query 参数仍可能在首次请求前进入浏览器历史或基础设施日志。
- 模型请求失败、返回空列表、描述符不匹配或默认模型无效时，不写入半完成渠道。
- 成功后的 API Key 按现有手动渠道机制保存在浏览器本地，仅适用于个人或可信设备。

## 测试

- 有效链接：URL 被清理，模型拉取成功，新增渠道并应用默认模型。
- 同 ID 手动渠道：仅该渠道被覆盖，其他渠道不变。
- 同 ID OIDC 渠道：拒绝导入，OIDC 会话和渠道不变。
- 无效描述符、无效 API Key、模型请求失败、空模型列表和无效默认模型：均不持久化 API Key 或渠道变更。
- 描述符中的 xAI 模型保留 `apiFormat: "xai"`，Sub2API 视频继续使用专用适配。
