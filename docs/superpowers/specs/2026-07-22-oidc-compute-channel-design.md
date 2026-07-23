# OIDC 算力渠道设计

## 目标

为无限画布增加一个由部署者注册、由每个浏览器分别授权的 OIDC 算力渠道。用户可在不创建无限画布账户的前提下，授权自己的上游父 API Key，并在该客户端已获授权的文本、图片和视频工作台及画布节点中使用对应算力与额度。

该渠道与用户手动填写的 API 渠道并存。画布、素材、历史记录和用户对模型能力的分类仍保存在浏览器本地。

## 非目标

- 不增加无限画布用户注册、登录、用户表、跨设备同步或额度转售能力。
- 不移除音频生成或其他现有功能。当前 OIDC scope 未包含音频模型，因此音频仅继续使用用户手填的渠道，直到部署者为 OAuth 客户端增加音频 scope。
- 不将 OAuth `client_secret`、派生 access token 或 ID Token 暴露给浏览器 JavaScript、URL、日志或分析服务。
- 不将 BFF 做成任意 URL 的通用转发服务，也不代理上游的 `/oauth/*`、`/api/v1/*` 或管理接口。
- 首期不支持 Vercel Functions；GitHub Pages 继续是无 OIDC 的纯静态预览部署。

## 部署架构

根目录新增独立的 TypeScript/Express BFF。生产容器先构建 `web/` 的 Vite 产物，再启动 BFF；BFF 同域提供静态页面、OIDC 接口和上游模型代理。Docker、Render、Knative 共用该镜像与运行方式。

部署者必须配置：

- `OIDC_ISSUER`：上游稳定 issuer URL。
- `OIDC_CLIENT_ID`：已注册的保密客户端 ID。
- `OIDC_CLIENT_SECRET`：保密客户端密钥。
- `OIDC_SESSION_KEY`：base64url 编码的 32 字节高熵会话加密密钥。
- `OIDC_PROVIDER_NAME`：前端显示名称；未设置时显示为“OIDC Provider”。
- `PUBLIC_ORIGIN`：当前部署的公开 HTTPS origin，用于生成并校验精确回调 URL。
- `OIDC_REQUESTED_SCOPES`：空格分隔的精确 OAuth scope。必须含唯一的 `openid`，其余值必须是管理员为该 `client_id` 登记的 `llm:<platform>:<model-alias>`。

当前部署配置的 scope 为：

```text
openid llm:grok:grok-imagine-image llm:grok:grok-imagine-image-quality llm:grok:grok-imagine-video llm:grok:grok-imagine-video-1.5 llm:openai:gpt-image-2 llm:openai:gpt-5.6-terra
```

其中 Grok 的两个 imagine image alias 初始归类为图片，两个 imagine video alias 初始归类为视频；`gpt-image-2` 初始归类为图片，`gpt-5.6-terra` 初始归类为文本。不存在音频模型。用户仍可调整已授权模型的能力分类，但不能绕过 scope 增加模型。

只有上述 OIDC 配置完整且 scope 格式合法时，BFF 才报告功能可用，前端才显示连接入口。名称、功能启用状态和连接状态可公开给前端；issuer、client ID、scope 配置与所有密钥均不得返回。Discovery 文档不作为 scope 来源，因为上游不会公开客户端专属的模型 scope。

## 授权与会话

1. 浏览器点击“连接 {Provider 名称}”。
2. BFF 读取 Discovery 文档，生成 `state` 与 nonce，并把它们及回调后的相对本地返回路径加密写入 10 分钟有效的 `oidc_transaction` Cookie。
3. BFF 将浏览器重定向到上游 `authorization_endpoint`，使用 `response_type=code` 与 `OIDC_REQUESTED_SCOPES` 的精确 scope。
4. 上游完成登录、父 Key 选择或拒绝后，回调 BFF 的注册 URL。
5. BFF 校验 `state`，使用 HTTP Basic 认证兑换 code，并通过 Discovery 中的 JWKS 校验 ID Token 的 `RS256`、issuer、audience 与 nonce。
6. BFF 对照配置 scope 验证 token 响应中的规范化 `scope`，加密写入 30 天有效的 `oidc_session` Cookie。其内容仅包含派生 access token、`sub`、issuer、已批准 scope 和必要的连接时间元数据；随后跳转回渠道设置。

两个 Cookie 都使用 `HttpOnly`、`SameSite=Lax`、`Path=/`；生产环境额外使用 `Secure`。Cookie 内容采用 AES-256-GCM 加密与认证，序列化使用 base64url；BFF 必须拒绝解密失败、过期或超出浏览器 Cookie 限制的值。关闭并重新打开浏览器后会话仍有效，但达到 30 天、清除 Cookie、主动断开或上游判定 token 无效后必须重新授权。

不使用 Redis、数据库或无限画布用户账户。会话只绑定当前浏览器配置，不能跨浏览器或设备迁移。部署者变更 `OIDC_REQUESTED_SCOPES` 后，已有会话的批准 scope 不再与当前配置匹配时，BFF 必须要求重新授权。

## BFF 接口与代理边界

同域 BFF 提供以下接口：

- `GET /api/oidc/config`：返回已启用状态与 Provider 显示名称。
- `POST /api/oidc/authorize`：建立授权事务并返回授权 URL；前端用顶层页面跳转到该 URL。
- `GET /api/oidc/callback`：处理授权回调，不向前端暴露 code 或 token。
- `GET /api/oidc/session`：返回当前连接状态、Provider 名称、批准 scope 及可用于界面显示的元数据。
- `GET /api/oidc/models`：返回当前会话允许的模型、平台和调用格式；模型清单以批准 scope 为上限，并可结合上游受限模型列表刷新。
- `DELETE /api/oidc/session`：以 BFF 客户端凭据调用上游 revocation endpoint；无论撤销结果如何均清除本地 Cookie。
- `ALL /api/oidc/proxy/*`：按白名单转发模型调用。

代理从会话 Cookie 中取得 access token，丢弃浏览器提交的 `Authorization`、API key 和目标 host，向 issuer 注入唯一的 `Authorization: Bearer <derived-token>`。它保留必要的内容类型、请求体、响应状态、二进制响应和 SSE 流，不缓冲生成流。

允许的上游路径仅限当前应用所需的模型 API：`/v1`、`/v1beta`、`/antigravity/v1beta` 下经过显式方法与路径规则验证的模型、生成、任务查询和模型列表端点。代理拒绝绝对 URL、路径穿越、未知路径、`/oauth/*`、`/api/v1/*` 和其他管理端点。自定义模型脚本仅可调用解析后仍命中该白名单的相对 Provider 路径；需要任意外部目标的脚本继续使用手填渠道。

所有状态变更接口和代理的非安全方法检查同源 `Origin`。BFF 不向其他 origin 开放 CORS。上游返回 `invalid_token`、401 或明确的授权撤销结果时，BFF 清除会话并以可识别错误返回，前端将该渠道标记为需要重新连接。

## 前端渠道模型与体验

渠道模型增加受管理认证类型，例如 `authMode: "manual" | "oidc"`；`ChannelModel` 增加可选的模型级 `apiFormat`。手填渠道继续使用渠道级协议、Base URL 与 API Key；OIDC 渠道不保存或展示任何 API Key、issuer、client ID 或 secret。

渠道设置新增由 BFF 配置驱动的受管理渠道卡片：

- 未连接：显示“连接 {Provider 名称}”。
- 连接中：禁用重复操作。
- 已连接：显示“{Provider 名称}”、模型数量、“同步模型”与“断开”。
- 失效：显示需重新连接的状态，手填渠道不受影响。

受管理渠道默认名称直接为 `{Provider 名称}`，不附加协议名称。授权后，前端经 BFF 的模型接口创建或更新该渠道模型列表；该接口只返回已批准 scope 对应的 alias。`llm:openai:*` 映射为模型级 OpenAI 格式，`llm:grok:*` 映射为模型级 xAI 格式，调用时优先采用模型级格式而非渠道默认格式。模型继续使用现有编辑器，用户可修改已授权模型的能力分类；OIDC 凭据、平台与模型列表不可编辑。当前列表不产生音频选项，音频工作台继续从手填渠道选择模型。

所有文本、图片、视频工作台和画布中的对应生成节点在选择该渠道时，使用 BFF 相对代理地址而不是直连上游。前端请求层必须识别 `authMode: "oidc"`，不要求或伪造 `apiKey`，并保持手填渠道与音频工作台的原有请求行为不变。

## 错误处理

- 用户取消授权、授权回调包含错误、`state`/nonce 校验失败、Discovery/JWKS 不可用或 token 交换失败：回到渠道设置并显示中文错误，不创建有效连接。
- 模型同步失败：保留已建立的连接并提示同步失败；用户可再次同步。
- 上游配额、限流、模型不可用和生成失败：透传到现有工作台错误处理，不误报为 OIDC 登录失败。
- 主动断开：始终清除 BFF 会话和本地受管理渠道连接状态，即使上游撤销调用返回失败或 token 已无效。
- 未配置 BFF：不显示 OIDC 入口；应用其余功能和纯静态预览继续可用。

## 验收与测试

服务端测试覆盖 Discovery、授权重定向、state/nonce、ID Token 验证、Cookie 加密与过期、token 交换、撤销、同源校验、代理鉴权重写、路径白名单、SSE、multipart 图片请求和二进制视频响应。

前端测试覆盖 Provider 名称显示、精确 scope 模型同步、模型级协议解析、模型能力编辑、断开与失效重连，以及手填渠道和音频功能回归。集成验收覆盖当前获授权的文本、图片、视频工作台和画布内对应生成节点，并确认音频仍可通过手填渠道工作。

部署验收覆盖 Docker、Render、Knative 的同域回调、页面刷新路由回退与环境变量缺失场景。GitHub Pages 验证 OIDC 入口隐藏且手填渠道保持可用。
