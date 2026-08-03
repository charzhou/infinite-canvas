# Sub2API 渠道链接导入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 通过固定 Sub2API 网关的入口链接自动验证 API Key、拉取授权模型，并按 `channelId` 创建或更新本地手动渠道。

**Architecture:** 新的纯函数模块负责解析 base64url 渠道描述符、清理 URL 和将已授权模型转换为渠道模型。配置 store 负责按 ID 原子更新手动渠道并重新归一化默认模型；入口页面只编排 URL、模型请求、状态显示和跳转。

**Tech Stack:** Vite, React 19, React Router, TypeScript, Zustand, Axios, Vitest, Testing Library, Ant Design, Tailwind.

## Global Constraints

- 入口路由固定为 `/connect/sub2api`，网关固定为 `https://sub2api.tegical.com`，链接不得覆盖该地址。
- 链接使用 `apiKey` 与 `channel` query；`channel` 是 base64url JSON 描述符。
- `channelId` 是手动渠道的唯一覆盖键；同 ID OIDC 渠道必须拒绝导入，绝不能被覆盖。
- 固定写入 `providerId: "sub2api"`，以保持 Sub2API OpenAI/xAI 视频适配。
- `baseUrl`、`authMode`、`providerId`、脚本、请求头和任意未声明字段不得从链接进入本地配置。
- URL 必须在任何异步请求前移除 API Key 与描述符；错误信息和日志不得包含 API Key。
- `/v1/models` 返回值是可用模型的唯一权限依据；描述符仅提供模型协议、能力、排序和默认项。
- 遵循项目约束：实现时添加测试，但不在此工作流中执行测试、构建或类型检查。

---

## File Structure

- Create: `web/src/lib/sub2api-channel-link.ts` - 解析和校验链接描述符，生成已授权渠道模型。
- Create: `web/src/lib/sub2api-channel-link.test.ts` - 覆盖描述符、URL 清理和模型交集规则。
- Modify: `web/src/stores/use-config-store.ts` - 提供按渠道 ID 写入 Sub2API 手动渠道的纯函数。
- Modify: `web/src/stores/use-config-store.test.ts` - 覆盖新增、覆盖、OIDC 冲突与默认模型归一化。
- Create: `web/src/pages/connect/sub2api.tsx` - URL 导入页面，负责模型验证、状态呈现与跳转。
- Create: `web/src/pages/connect/sub2api.test.tsx` - 覆盖页面成功与失败状态，不让失败写入 store。
- Modify: `web/src/router.tsx` - 注册入口页路由。
- Modify: `web/src/components/layout/client-root-init.tsx` - 排除入口页，避免旧通用参数导入覆盖默认渠道。
- Modify: `CHANGELOG.md` - 在 `Unreleased` 添加版本级变更记录。
- Modify: `docs/content/docs/progress/pending-test.mdx` - 记录人工可测的入口链接行为。

### Task 1: 链接描述符与授权模型解析

**Files:**
- Create: `web/src/lib/sub2api-channel-link.ts`
- Create: `web/src/lib/sub2api-channel-link.test.ts`

**Interfaces:**
- Produces: `Sub2ApiChannelDescriptor`, `readSub2ApiChannelLink(search)`, `clearSub2ApiChannelLink(search)`, `resolveSub2ApiChannelModels(discovered, descriptor)`.
- Consumes: `ChannelModel`, `ModelCapability`, `ApiCallFormat`, `guessCapability` from `@/stores/use-config-store`.

- [ ] **Step 1: Write failing parser and resolver tests**

```ts
const descriptor = { channelId: "tenant-a", name: "Tenant A", models: [{ name: "grok-imagine-video", capability: "video", apiFormat: "xai" }], defaults: { video: "grok-imagine-video" } };
const channel = btoa(JSON.stringify(descriptor)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

it("reads the key and a base64url descriptor, then removes both parameters", () => {
    expect(readSub2ApiChannelLink(`?apiKey=sk-test&channel=${channel}`)).toEqual({ apiKey: "sk-test", descriptor });
    expect(clearSub2ApiChannelLink(`?apiKey=sk-test&channel=${channel}&next=1`)).toBe("?next=1");
});

it("keeps only models granted by /v1/models and preserves declared xAI metadata", () => {
    expect(resolveSub2ApiChannelModels(["gpt-5.6-terra", "grok-imagine-video"], descriptor)).toEqual([
        { name: "grok-imagine-video", capability: "video", apiFormat: "xai" },
    ]);
});
```

- [ ] **Step 2: Implement the strict descriptor schema**

```ts
export type Sub2ApiChannelDescriptor = {
    channelId: string;
    name?: string;
    models?: Array<{ name: string; capability?: ModelCapability; apiFormat?: ApiCallFormat }>;
    defaults?: Partial<Record<ModelCapability, string>>;
};

export function readSub2ApiChannelLink(search: string): { apiKey: string; descriptor: Sub2ApiChannelDescriptor } {
    // Require one non-empty apiKey and channel, decode UTF-8 base64url JSON, reject unknown fields.
}

export function resolveSub2ApiChannelModels(discovered: string[], descriptor: Sub2ApiChannelDescriptor): ChannelModel[] {
    // Deduplicate discovered IDs; if models are declared, retain declaration order only for discovered names.
    // Otherwise return all discovered names with guessCapability(name).
}
```

Validate `channelId` against `^[A-Za-z0-9_-]{1,64}$`, trim names, allow only `openai`, `gemini`, `xai`, or `ark` protocol values, allow only the four existing capability values, reject duplicate model names, and reject defaults whose names are absent from the resolved model list. Reject an empty model response.

- [ ] **Step 3: Add failure-case tests**

```ts
it.each(["?apiKey=&channel=x", "?apiKey=sk-test", "?apiKey=sk-test&channel=not-base64"])("rejects an invalid link: %s", (search) => {
    expect(() => readSub2ApiChannelLink(search)).toThrow("Sub2API 授权链接无效");
});

it("rejects a default model not granted to the API Key", () => {
    expect(() => resolveSub2ApiChannelModels(["gpt-5.6-terra"], { channelId: "tenant-a", defaults: { video: "grok-imagine-video" } })).toThrow("默认模型不可用");
});
```

- [ ] **Step 4: Commit the parsing unit**

```bash
git add web/src/lib/sub2api-channel-link.ts web/src/lib/sub2api-channel-link.test.ts
git commit -m "feat: parse Sub2API channel links"
```

### Task 2: 按渠道 ID 原子导入本地配置

**Files:**
- Modify: `web/src/stores/use-config-store.ts`
- Modify: `web/src/stores/use-config-store.test.ts`

**Interfaces:**
- Consumes: `Sub2ApiChannelDescriptor` and resolved `ChannelModel[]` from `@/lib/sub2api-channel-link`.
- Produces: `importSub2ApiChannel(config, { apiKey, descriptor, models }): AiConfig`.

- [ ] **Step 1: Write failing store tests**

```ts
it("adds a Sub2API manual channel with the fixed gateway and requested defaults", () => {
    const result = importSub2ApiChannel(defaultConfig, { apiKey: "sk-test", descriptor: { channelId: "tenant-a", defaults: { text: "gpt-5.6-terra" } }, models: [{ name: "gpt-5.6-terra", capability: "text" }] });
    expect(result.channels.find((channel) => channel.id === "tenant-a")).toMatchObject({ baseUrl: "https://sub2api.tegical.com", apiKey: "sk-test", authMode: "manual", providerId: "sub2api" });
    expect(result.textModel).toBe("tenant-a::gpt-5.6-terra");
});

const configWithManualTenantAndOidc = {
    ...defaultConfig,
    channels: [
        { id: "tenant-a", name: "旧 Tenant", baseUrl: "https://old.example", apiKey: "old-key", apiFormat: "openai", authMode: "manual", models: [{ name: "old-model", capability: "text" }] },
        { id: "oidc", name: "受管理", baseUrl: "/api/oidc/proxy", apiKey: "", apiFormat: "openai", authMode: "oidc", providerId: "sub2api", models: [{ name: "gpt-5.6-terra", capability: "text" }] },
    ],
} as AiConfig;
const importInput = { apiKey: "sk-test", descriptor: { channelId: "tenant-a", name: "Tenant A" }, models: [{ name: "gpt-5.6-terra", capability: "text" as const }] };

it("replaces a same-ID manual channel without touching other channels", () => {
    const result = importSub2ApiChannel(configWithManualTenantAndOidc, importInput);
    expect(result.channels.map((channel) => channel.id)).toEqual(["tenant-a", "oidc"]);
    expect(result.channels[0].apiKey).toBe("sk-test");
});

it("rejects a same-ID OIDC channel", () => {
    expect(() => importSub2ApiChannel(configWithOidcGrokVideo, { ...importInput, descriptor: { ...importInput.descriptor, channelId: "oidc" } })).toThrow("OIDC 渠道不能通过授权链接覆盖");
});
```

- [ ] **Step 2: Implement the pure store function**

```ts
export const SUB2API_GATEWAY_BASE_URL = "https://sub2api.tegical.com";

export function importSub2ApiChannel(
    config: AiConfig,
    input: { apiKey: string; descriptor: Sub2ApiChannelDescriptor; models: ChannelModel[] },
): AiConfig {
    const existing = config.channels.find((channel) => channel.id === input.descriptor.channelId);
    if (existing?.authMode === "oidc") throw new Error("OIDC 渠道不能通过授权链接覆盖");
    const channel = createModelChannel({ id: input.descriptor.channelId, name: input.descriptor.name || existing?.name || "Sub2API", baseUrl: SUB2API_GATEWAY_BASE_URL, apiKey: input.apiKey, apiFormat: "openai", authMode: "manual", providerId: "sub2api", models: input.models });
    const normalized = withNormalizedChannels(config, [...config.channels.filter((item) => item.id !== channel.id), channel]);
    return applyDescriptorDefaults(normalized, input.descriptor.defaults, channel.id);
}
```

`applyDescriptorDefaults` must encode each declared default with the imported channel ID and only replace the corresponding `imageModel`, `videoModel`, `textModel`, or `audioModel`; unspecified capabilities retain the normalized fallback from `withNormalizedChannels`.

- [ ] **Step 3: Add regression coverage for a declared xAI video model**

```ts
it("keeps the declared xAI format and Sub2API adapter after import", () => {
    const result = importSub2ApiChannel(defaultConfig, { apiKey: "sk-test", descriptor: { channelId: "tenant-a" }, models: [{ name: "grok-imagine-video", capability: "video", apiFormat: "xai" }] });
    expect(resolveModelRequestConfig(result, "tenant-a::grok-imagine-video")).toMatchObject({ apiFormat: "xai", providerId: "sub2api" });
});
```

- [ ] **Step 4: Commit the store unit**

```bash
git add web/src/stores/use-config-store.ts web/src/stores/use-config-store.test.ts
git commit -m "feat: import Sub2API channels by ID"
```

### Task 3: 入口页面与路由

**Files:**
- Create: `web/src/pages/connect/sub2api.tsx`
- Create: `web/src/pages/connect/sub2api.test.tsx`
- Modify: `web/src/router.tsx`
- Modify: `web/src/components/layout/client-root-init.tsx`

**Interfaces:**
- Consumes: `readSub2ApiChannelLink`, `clearSub2ApiChannelLink`, `resolveSub2ApiChannelModels`, `fetchChannelModels`, `importSub2ApiChannel`, `useConfigStore`.
- Produces: `/connect/sub2api`, which either redirects to `/` after a committed import or renders a non-sensitive Chinese failure state.

- [ ] **Step 1: Write failing page tests with mocked model discovery**

```tsx
vi.mock("@/services/api/image", () => ({ fetchChannelModels: vi.fn() }));

it("cleans the URL before importing the fetched models and redirects home", async () => {
    window.history.replaceState(null, "", `/connect/sub2api?apiKey=sk-test&channel=${validChannel}`);
    vi.mocked(fetchChannelModels).mockResolvedValue(["gpt-5.6-terra"]);
    render(<MemoryRouter initialEntries={[window.location.pathname + window.location.search]}><Sub2ApiConnectPage /></MemoryRouter>);
    await waitFor(() => expect(useConfigStore.getState().config.channels.some((channel) => channel.id === "tenant-a")).toBe(true));
    expect(window.location.search).toBe("");
});

it("does not persist a channel when model discovery rejects", async () => {
    vi.mocked(fetchChannelModels).mockRejectedValue(new Error("读取模型失败"));
    render(<MemoryRouter initialEntries={[validLink]}><Sub2ApiConnectPage /></MemoryRouter>);
    await screen.findByText("授权失败");
    expect(useConfigStore.getState().config.channels.some((channel) => channel.id === "tenant-a")).toBe(false);
});
```

- [ ] **Step 2: Implement the page state machine**

```tsx
type Status = "loading" | "failed";

export default function Sub2ApiConnectPage() {
    const navigate = useNavigate();
    const [status, setStatus] = useState<Status>("loading");

    useEffect(() => {
        const sourceSearch = window.location.search;
        const cleanSearch = clearSub2ApiChannelLink(sourceSearch);
        window.history.replaceState(null, "", `${window.location.pathname}${cleanSearch}${window.location.hash}`);
        void importLink(sourceSearch).then(() => navigate("/", { replace: true })).catch(() => setStatus("failed"));
    }, [navigate]);
}
```

`importLink(sourceSearch)` must parse before fetching, call `fetchChannelModels({ id: descriptor.channelId, name: descriptor.name || "Sub2API", baseUrl: SUB2API_GATEWAY_BASE_URL, apiKey, apiFormat: "openai", authMode: "manual", providerId: "sub2api", models: [] })`, resolve models, and call `useConfigStore.setState` only after every validation succeeds. Render a compact Chinese loading state and a failure state titled `授权失败`; neither state may expose the API Key or raw request error.

- [ ] **Step 3: Exclude the dedicated route from the legacy global importer**

Add this guard before `ClientRootInit` reads `baseUrl` or `apiKey`:

```ts
if (window.location.pathname === "/connect/sub2api") return;
```

The root initializer wraps every route through `AppProviders`, so moving the route outside `UserLayout` alone is insufficient. The dedicated page owns all parameters on this path; existing generic `baseUrl`/`apiKey` links on other routes retain their current behavior.

- [ ] **Step 4: Register the route outside the `UserLayout` route tree**

```tsx
import Sub2ApiConnectPage from "@/pages/connect/sub2api";

{ path: "/connect/sub2api", element: <Sub2ApiConnectPage /> },
```

Place it before the catch-all route. It avoids the ordinary navigation shell while the `ClientRootInit` path guard prevents the global importer from consuming this link.

- [ ] **Step 5: Commit the UI unit**

```bash
git add web/src/pages/connect/sub2api.tsx web/src/pages/connect/sub2api.test.tsx web/src/router.tsx web/src/components/layout/client-root-init.tsx
git commit -m "feat: add Sub2API channel link entry"
```

### Task 4: 用户可见文档与待测记录

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/content/docs/progress/pending-test.mdx`
- Inspect: `docs/content/docs/progress/todo.mdx`

**Interfaces:**
- Consumes: implemented route `/connect/sub2api` and the fixed `https://sub2api.tegical.com` gateway contract.
- Produces: an `Unreleased` entry and a precise manual verification item; `todo.mdx` remains unchanged because no existing todo item is being completed.

- [ ] **Step 1: Add the Unreleased changelog entry**

Add directly below `## Unreleased`:

```md
+ [新增] 支持通过固定 Sub2API 网关的授权链接自动验证 API Key、导入授权模型并按渠道 ID 更新本地渠道。
```

- [ ] **Step 2: Add the pending-test scenario**

Add a Chinese bullet describing: open `/connect/sub2api` with a valid `apiKey` and base64url `channel`; confirm the address bar immediately removes both parameters, `/v1/models` models are imported, the same-ID manual channel is replaced while other and OIDC channels stay unchanged, declared xAI video models use the correct protocol, and an invalid key/descriptor/empty model list leaves no new or modified channel and never displays the key.

- [ ] **Step 3: Commit the documentation unit**

```bash
git add CHANGELOG.md docs/content/docs/progress/pending-test.mdx
git commit -m "docs: record Sub2API channel link import"
```
