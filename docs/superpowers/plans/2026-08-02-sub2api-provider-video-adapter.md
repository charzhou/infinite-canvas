# Sub2API Provider Video Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the managed Sub2API video channel use its current OpenAI Video and xAI Video contracts while leaving all generic channel video behavior unchanged.

**Architecture:** Carry an internal `providerId: "sub2api"` from the OIDC-managed channel into resolved request configuration. The shared video service selects a dedicated Sub2API adapter only for that provider, while the existing generic OpenAI, xAI, Seedance, and plugin functions retain their current requests and polling. Every Sub2API task stores `adapter: "sub2api"` so refresh-safe polling retains the creation-time adapter.

**Tech Stack:** TypeScript, React, Zustand, Axios, Express, Vitest, localforage-backed generation logs.

## Global Constraints

- `providerId` is an internal stable identifier. Never infer it from a channel display name, model name, base URL, or `providerName`.
- `apiFormat` continues to select the OpenAI or xAI inbound request shape.
- Do not modify the behavior or payloads of generic OpenAI, generic xAI, Seedance, or plugin video paths.
- Do not retry a Sub2API creation after timeout or `5xx`; do not change request encoding after a failed create.
- Do not persist a private signed `video.url` as an asset URL. Download bytes and use existing local media storage.
- Follow `AGENTS.md`: scope edits to this feature, use Chinese user-facing copy, and update `CHANGELOG.md` plus progress documentation.

---

### Task 1: Propagate the Managed Provider Identifier

**Files:**
- Modify: `web/src/stores/use-config-store.ts:17-25,56,282-353`
- Modify: `web/src/stores/use-oidc-store.ts:6-16,26-84`
- Modify: `web/src/stores/use-config-store.test.ts`

**Interfaces:**
- Consumes: the existing OIDC-managed channel with `id: "oidc"` and `authMode: "oidc"`.
- Produces: `ModelChannel.providerId?: "sub2api"` and `ModelRequestConfig.providerId?: "sub2api"`.
- Produces: `isSub2ApiVideoConfig(config: ModelRequestConfig): boolean`, implemented as `config.providerId === "sub2api"` in the Sub2API adapter module.

- [ ] **Step 1: Write failing configuration-resolution tests**

Add a Sub2API OIDC channel fixture and verify the provider survives normalization and is included in resolved request config:

```ts
const sub2ApiChannel = {
  id: "oidc",
  name: "算力渠道",
  baseUrl: "/api/oidc/proxy",
  apiKey: "",
  apiFormat: "openai",
  authMode: "oidc",
  providerId: "sub2api" as const,
  models: [{ name: "grok-imagine-video", capability: "video" as const, apiFormat: "xai" as const }],
};

it("keeps the managed Sub2API provider on resolved model config", () => {
  const config = { ...configWithOidcGrokVideo, channels: [sub2ApiChannel] } as AiConfig;
  expect(resolveModelRequestConfig(config, "oidc::grok-imagine-video").providerId).toBe("sub2api");
});
```

- [ ] **Step 2: Run the focused test to establish the missing field**

Run: `npm test -- web/src/stores/use-config-store.test.ts`

Expected: TypeScript/test failure because `providerId` is absent from the channel and resolved-config types.

- [ ] **Step 3: Add and preserve the provider identifier**

In `web/src/stores/use-config-store.ts`:

```ts
export type ManagedProviderId = "sub2api";

export type ModelChannel = {
  // Existing channel fields.
  providerId?: ManagedProviderId;
};

export type ModelRequestConfig = AiConfig & Pick<ModelChannel, "authMode" | "providerId">;
```

Preserve `providerId` in `createModelChannel`, then return `providerId: channel.providerId` from `resolveModelRequestConfig`.

In `web/src/stores/use-oidc-store.ts`, add `providerId: "sub2api"` when calling `syncManagedOidcChannel`. This marker remains internal and does not affect the channel name rendered from `providerName`.

- [ ] **Step 4: Run the focused configuration tests**

Run: `npm test -- web/src/stores/use-config-store.test.ts`

Expected: existing API-format precedence tests and the new provider-resolution test pass.

- [ ] **Step 5: Commit the provider plumbing**

```bash
git add web/src/stores/use-config-store.ts web/src/stores/use-oidc-store.ts web/src/stores/use-config-store.test.ts
git commit -m "feat: mark managed Sub2API channels"
```

### Task 2: Add the Isolated Sub2API Video Adapter

**Files:**
- Create: `web/src/services/api/sub2api-video.ts`
- Modify: `web/src/services/api/video.ts:13-35,76-109`
- Modify: `web/src/services/api/video.test.ts`

**Interfaces:**
- Consumes: `ModelRequestConfig` with `providerId: "sub2api"`, a selected `apiFormat`, prompt, image references, and optional abort signal.
- Produces: `createSub2ApiVideoTask(config, model, prompt, references, options): Promise<VideoGenerationTask>`.
- Produces: `pollSub2ApiVideoTask(config, task, options): Promise<VideoGenerationTaskState>`.
- Extends: `VideoGenerationTask` with `adapter?: "sub2api"`; generic tasks continue to omit this property.

- [ ] **Step 1: Write failing adapter dispatch and payload tests**

Create a Sub2API OpenAI fixture and reuse the OIDC xAI fixture with `providerId: "sub2api"`. Add assertions that distinguish the adapter from generic code:

```ts
expect(axios.post).toHaveBeenCalledWith(
  "/api/oidc/proxy/v1/videos",
  {
    model: "video-model",
    prompt: "测试视频",
    seconds: "6",
    size: "1280x720",
    preset: "normal",
    input_reference: [{ type: "image", image_url: image.dataUrl }],
  },
  { headers: { Authorization: "Bearer ", "Content-Type": "application/json" }, signal: undefined },
);

expect(xaiPayload).toMatchObject({
  duration: 6,
  aspect_ratio: "16:9",
  resolution: "720p",
  reference_images: [{ url: image.dataUrl }, { url: image.dataUrl }],
});
expect(xaiPayload).not.toHaveProperty("images");
```

Also assert returned tasks include `adapter: "sub2api"`, while an existing non-Sub2API xAI fixture still sends `images` and returns no adapter.

- [ ] **Step 2: Run the focused video tests to establish the old generic behavior**

Run: `npm test -- web/src/services/api/video.test.ts`

Expected: the new Sub2API assertions fail because generic functions emit multipart OpenAI and `images` for xAI references.

- [ ] **Step 3: Implement Sub2API request construction in a dedicated module**

Create `sub2api-video.ts`; keep Axios request helpers local to this adapter so the generic request functions are untouched.

Implement the adapter dispatch as follows:

```ts
export async function createSub2ApiVideoTask(config, model, prompt, references, options) {
  return config.apiFormat === "xai"
    ? createSub2ApiXaiVideoTask(config, model, prompt, references, options)
    : createSub2ApiOpenAIVideoTask(config, model, prompt, references, options);
}
```

For OpenAI, post JSON to `/videos` with a positive string `seconds`, an explicit normalized `size`, `preset: "normal"`, and `input_reference` entries shaped as `{ type: "image", image_url }`. Convert references with `imageToDataUrl`; do not construct `FormData`, include `resolution_name`, or impose the generic seven-image cap.

For xAI, post JSON to `/videos/generations` with numeric `duration` clamped to `1..15`, `resolution`, an `aspect_ratio` reduced from the normalized `WIDTHxHEIGHT` size, `preset: "normal"`, and either one `image` or plural `reference_images`. Do not send generic `images`.

Both create functions return:

```ts
{ id, provider: "openai" | "xai", model, adapter: "sub2api" }
```

- [ ] **Step 4: Route only marked providers through the adapter**

In `createVideoGenerationTask`, preserve plugin and Seedance precedence. Immediately after those checks, dispatch only a request config marked `providerId === "sub2api"` to `createSub2ApiVideoTask`; leave the following generic xAI and OpenAI branches byte-for-byte behaviorally unchanged.

In `pollVideoGenerationTask`, before generic provider polling, dispatch `task.adapter === "sub2api"` to `pollSub2ApiVideoTask`. The adapter marker, not the currently selected channel, determines parsing after a page refresh.

- [ ] **Step 5: Run the adapter and generic-regression tests**

Run: `npm test -- web/src/services/api/video.test.ts`

Expected: Sub2API OpenAI uses JSON, Sub2API xAI uses `reference_images`, and existing generic xAI assertions retain `images`.

- [ ] **Step 6: Commit the provider-specific creation adapter**

```bash
git add web/src/services/api/sub2api-video.ts web/src/services/api/video.ts web/src/services/api/video.test.ts
git commit -m "feat: add Sub2API video request adapter"
```

### Task 3: Implement Sub2API Status and Private-Media Retrieval

**Files:**
- Modify: `web/src/services/api/sub2api-video.ts`
- Modify: `web/src/services/api/video.test.ts`

**Interfaces:**
- Consumes: persisted `{ id, provider, model, adapter: "sub2api" }` task and its resolved request configuration.
- Produces: pending, completed Blob result, or terminal failure through the existing `VideoGenerationTaskState` union.
- Preserves: the video workbench's existing `storeGeneratedVideo` flow and locally stored final video asset.

- [ ] **Step 1: Write failing status and download tests**

Add tests for both state projections:

```ts
vi.mocked(axios.get)
  .mockResolvedValueOnce({ data: { status: "completed", video: { url: "https://storage.example/video.mp4" } } })
  .mockResolvedValueOnce({ data: new Blob(["video"], { type: "video/mp4" }) });

await expect(pollVideoGenerationTask(config, {
  id: "video_1", provider: "openai", model: "oidc::video-model", adapter: "sub2api",
})).resolves.toEqual({ status: "completed", result: { blob: expect.any(Blob) } });
```

Assert the signed `video.url` download sends no gateway `Authorization` header. Add a second case without `video.url` that calls `/videos/{id}/content` with the gateway credentials. Add xAI `done`, `failed`, and `expired` assertions.

- [ ] **Step 2: Run the focused polling tests to establish missing behavior**

Run: `npm test -- web/src/services/api/video.test.ts`

Expected: failing assertions because no Sub2API poll dispatcher or nested `video.url` retrieval exists.

- [ ] **Step 3: Implement protocol-specific status parsing**

Implement `pollSub2ApiVideoTask` in `sub2api-video.ts`:

```ts
if (task.provider === "xai") return pollSub2ApiXaiVideoTask(config, task, options);
return pollSub2ApiOpenAIVideoTask(config, task, options);
```

OpenAI treats `queued` and `in_progress` as pending, `completed` as successful only after a downloadable media result is obtained, and `failed` as terminal. xAI treats `done` as successful and `failed`/`expired` as terminal. Preserve documented error messages when present.

For a completed task, fetch `video.url` directly without `Authorization` and validate a non-empty video Blob. If no URL is returned or its direct fetch cannot produce a valid Blob, request the same task's `/content` endpoint with gateway credentials and validate that Blob. Return only `{ blob }`; do not return or persist the signed URL.

- [ ] **Step 4: Run the focused polling tests**

Run: `npm test -- web/src/services/api/video.test.ts`

Expected: both OpenAI and xAI Sub2API task shapes complete through a Blob, while generic polling tests remain unchanged.

- [ ] **Step 5: Commit the Sub2API polling adapter**

```bash
git add web/src/services/api/sub2api-video.ts web/src/services/api/video.test.ts
git commit -m "feat: support Sub2API video task delivery"
```

### Task 4: Record User-Visible Verification Scope

**Files:**
- Modify: `CHANGELOG.md:3-4`
- Modify: `docs/content/docs/progress/pending-test.mdx:58-77`
- Review: `docs/content/docs/progress/todo.mdx`

**Interfaces:**
- Consumes: completed Sub2API provider adapter behavior from Tasks 1-3.
- Produces: one release-level changelog entry and concrete manual verification instructions for the OIDC/Sub2API channel.

- [ ] **Step 1: Update the unreleased changelog**

Under `## Unreleased`, add exactly one Chinese release-level entry:

```md
+ [调整] OIDC 受管的 Sub2API 视频渠道改用独立协议适配，兼容当前 OpenAI Video 与 xAI Video 任务合同而不影响其他渠道。
```

- [ ] **Step 2: Add pending-test coverage**

Append a concise Chinese bullet under `# OIDC 算力渠道` requiring verification that:

```md
- Sub2API 受管理视频渠道：OpenAI Video 模型以 JSON 调用 `/v1/videos`，xAI 模型以 `reference_images` 调用 `/v1/videos/generations`；普通手动 OpenAI/xAI 渠道的原请求格式不变。两类完成任务均应下载为本地媒体资产，刷新后未完成的任务仍按创建时协议继续轮询。
```

Confirm `todo.mdx` has no completed item to move; do not add this completed implementation as a future todo.

- [ ] **Step 3: Review documentation changes**

Run: `git diff --check`

Expected: no whitespace errors; `CHANGELOG.md` stays release-level and `pending-test.mdx` contains the concrete test surface.

- [ ] **Step 4: Commit documentation**

```bash
git add CHANGELOG.md docs/content/docs/progress/pending-test.mdx
git commit -m "docs: record Sub2API video adapter verification"
```

## Plan Self-Review

- Spec coverage: Task 1 implements stable provider binding; Task 2 isolates creation behavior and preserves generic paths; Task 3 persists adapter-driven polling and private-media delivery; Task 4 records the user-visible change and verification requirements.
- No-placeholder check: every task identifies exact files, interfaces, expected payloads, test scenarios, and commit commands.
- Type consistency: the sole new provider value is `"sub2api"`; all adapter task records use `adapter: "sub2api"`; OpenAI/xAI remain the existing `VideoGenerationTask.provider` values.
