# Sub2API 渠道授权链接接入指南

本文面向需要向 Infinite Canvas 用户发放 Sub2API 渠道的第三方系统。第三方生成一个授权链接；用户打开链接后，Infinite Canvas 会验证 API Key、读取该 Key 实际可用的模型，并在浏览器本地创建或更新对应渠道。

本指南适用于 Infinite Canvas `v0.12.5` 及以后版本。

## 1. 接入结果

用户打开有效链接后，Infinite Canvas 会：

1. 立即从地址栏移除 `apiKey` 和 `channel` 参数。
2. 使用固定网关 `https://sub2api.tegical.com` 请求 `/v1/models` 验证 API Key。
3. 仅导入 API Key 实际有权使用的模型。
4. 以 `channelId` 为唯一标识创建或更新一个本地手动渠道。
5. 成功后跳转到首页；失败时不创建或修改任何渠道。

导入的渠道固定使用 `providerId: "sub2api"`，因此不能通过链接修改网关地址、鉴权模式、请求头或调用脚本。

## 2. 链接格式

```text
https://<Infinite Canvas 域名>/connect/sub2api?apiKey=<URL 编码的 API Key>&channel=<base64url JSON>
```

- 入口路径必须是 `/connect/sub2api`。
- `apiKey` 和 `channel` 必须各出现一次，且不能为空。
- `channel` 是 UTF-8 JSON 的 base64url 编码，使用 `-`、`_` 替代 `+`、`/`，并移除结尾的 `=`。
- Infinite Canvas 部署地址由接入方决定；模型网关始终是 `https://sub2api.tegical.com`，链接不能覆盖它。

## 3. 渠道描述符

解码后的 `channel` 只能包含下列字段，传入其他字段会被拒绝。

```json
{
  "channelId": "acme-production",
  "name": "Acme Production",
  "models": [
    {
      "name": "gpt-5.6-terra",
      "capability": "text",
      "apiFormat": "openai"
    },
    {
      "name": "grok-imagine-video",
      "capability": "video",
      "apiFormat": "xai"
    }
  ],
  "defaults": {
    "text": "gpt-5.6-terra",
    "video": "grok-imagine-video"
  }
}
```

| 字段 | 必填 | 约束与含义 |
| --- | --- | --- |
| `channelId` | 是 | 渠道唯一标识，匹配 `^[A-Za-z0-9_-]{1,64}$`。相同 ID 的手动渠道会被整体覆盖。 |
| `name` | 否 | 用户可见名称；非空字符串，首尾空白会移除。未提供时保留已有同 ID 手动渠道的名称，或使用 `Sub2API`。 |
| `models` | 否 | 希望显示的模型白名单及元数据。省略时，导入 `/v1/models` 返回的全部模型并自动判断能力。不要传空数组。 |
| `models[].name` | 是 | 非空模型 ID；同一描述符中不能重复。 |
| `models[].capability` | 否 | `image`、`video`、`text` 或 `audio`。省略时由 Infinite Canvas 根据模型名推断。 |
| `models[].apiFormat` | 否 | `openai`、`gemini`、`xai` 或 `ark`。例如 xAI 视频模型应显式传入 `xai`。 |
| `defaults` | 否 | 默认模型映射，键只能是 `image`、`video`、`text`、`audio`；值必须是当前导入结果中具有对应能力的模型名。 |

`models` 只是展示与协议元数据，不能扩大权限。Infinite Canvas 会将它与 `/v1/models` 的返回值取交集；描述符中的未授权模型不会导入。若交集为空、网关未返回任何模型，或默认模型不在交集内，整个导入失败。

## 4. 生成链接

以下示例在第三方服务端或可信的管理工具中生成链接。不要把真实 API Key 写入前端源码、仓库或日志。

```ts
const descriptor = {
  channelId: "acme-production",
  name: "Acme Production",
  models: [
    { name: "gpt-5.6-terra", capability: "text", apiFormat: "openai" },
    { name: "grok-imagine-video", capability: "video", apiFormat: "xai" },
  ],
  defaults: {
    text: "gpt-5.6-terra",
    video: "grok-imagine-video",
  },
};

const bytes = new TextEncoder().encode(JSON.stringify(descriptor));
const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
const channel = btoa(binary)
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");

const link = new URL("/connect/sub2api", "https://canvas.example.com");
link.search = new URLSearchParams({
  apiKey: "<发放给该用户的 API Key>",
  channel,
}).toString();

console.log(link.toString());
```

将 `https://canvas.example.com` 替换为实际部署 Infinite Canvas 的 HTTPS 域名。API Key 会由 `URLSearchParams` 正确编码；不要自行拼接 query string。

## 5. 更新与冲突规则

- 不存在相同 `channelId` 时，新增手动渠道。
- 已存在相同 `channelId` 的手动渠道时，使用链接中的 API Key、名称、模型和默认项整体更新该渠道；其他渠道保持不变。
- 已存在相同 `channelId` 的 OIDC 受管理渠道时，拒绝导入，绝不覆盖该 OIDC 渠道。
- 未指定的默认能力不会强行修改；指定的默认项会指向该次导入后的渠道模型。

## 6. 安全要求

`apiKey` 是凭据。虽然 Infinite Canvas 会在应用和分析初始化前同步从地址栏移除该参数，但 URL 在到达浏览器前仍可能被反向代理、访问日志、浏览器历史、崩溃报告或第三方跳转记录。接入方必须接受并控制这一风险：

- 只通过 HTTPS 发放和打开链接，不经过广告、分析、短链或会向第三方发送 URL 的跳转页。
- 链接生成、访问日志、客服工单、埋点和错误报告都必须脱敏 `apiKey` 与完整链接。
- 优先发放权限最小、可撤销的专用 API Key；上游支持时使用短时有效凭据。
- 不要通过聊天记录、公开网页、邮件正文或截图长期保存完整链接。
- 用户成功导入后，API Key 会作为浏览器本地渠道配置的一部分保存，适用 Infinite Canvas 的本地 API Key 安全边界。

## 7. 故障处理

用户页面只会显示通用的“授权失败”，不会展示 API Key 或网关原始错误。第三方排查时按以下顺序检查：

1. 入口域名、路径和 query 参数是否正确，且 `apiKey`、`channel` 没有重复。
2. `channel` 是否为合法 UTF-8 JSON 的 base64url 编码，字段是否严格符合本指南的 schema。
3. API Key 是否能通过 `https://sub2api.tegical.com/v1/models` 返回至少一个模型。
4. 声明的 `models` 与实际授权模型是否至少有一个同名模型。
5. `defaults` 中的模型是否在最终导入结果中，且能力与默认项键一致。
6. `channelId` 是否与一个已有 OIDC 渠道冲突。
