# OIDC Gateway CDN Base URL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route constrained OIDC compute proxy requests through an optional CDN gateway origin while preserving the canonical OIDC issuer for discovery and ID Token validation.

**Architecture:** `OidcConfig` gains an optional-origin-derived `gatewayBaseUrl` property that falls back to `issuer`. OIDC discovery and token code remain unchanged; only `proxyGatewayRequest` resolves allowed `/v1/*` paths against `gatewayBaseUrl`. Deployment templates surface the new optional environment variable without storing real credentials.

**Tech Stack:** TypeScript, Node.js test runner, Express, Undici, Kubernetes Knative Serving.

## Global Constraints

- `OIDC_ISSUER` remains the canonical bare HTTP(S) issuer origin.
- `OIDC_GATEWAY_BASE_URL` accepts only a bare HTTP(S) origin and defaults to `OIDC_ISSUER`.
- Only the existing allowlisted proxy paths may use `OIDC_GATEWAY_BASE_URL`.
- Browser-supplied host and authorization values remain ignored by the proxy.
- OIDC discovery, authorization, code exchange, revocation, JWKS lookup, and ID Token `iss` validation do not use the gateway base URL.
- Deployment examples must not contain real client secrets or session keys.

---

### Task 1: Model and Validate the Gateway Origin

**Files:**
- Modify: `server/src/config.ts:10-90`
- Modify: `server/test/config.test.ts:18-41`

**Interfaces:**
- Produces: `OidcConfig.gatewayBaseUrl: URL`
- Consumes: `OIDC_GATEWAY_BASE_URL?: string`

- [ ] **Step 1: Write the failing configuration tests**

```ts
test("loads a configured CDN gateway origin", () => {
    const config = loadOidcConfig({ ...testEnv, OIDC_GATEWAY_BASE_URL: "https://cdn.example/" });
    assert.equal(config?.gatewayBaseUrl.toString(), "https://cdn.example/");
});

test("falls back to the issuer when no gateway origin is configured", () => {
    const config = loadOidcConfig(testEnv);
    assert.equal(config?.gatewayBaseUrl.toString(), "https://issuer.example/");
});

test("rejects a gateway origin with a path", () => {
    assert.throws(() => loadOidcConfig({ ...testEnv, OIDC_GATEWAY_BASE_URL: "https://cdn.example/v1" }));
});
```

- [ ] **Step 2: Run the configuration test file and verify RED**

Run: `npx tsx --test --test-name-pattern='gateway origin' test/config.test.ts`

Expected: FAIL because `gatewayBaseUrl` and `OIDC_GATEWAY_BASE_URL` handling do not exist.

- [ ] **Step 3: Add the minimal configuration implementation**

```ts
export type OidcConfig = {
    // existing fields
    gatewayBaseUrl: URL;
};

// Inside loadOidcConfig's return value:
gatewayBaseUrl: normalizedOrigin(env.OIDC_GATEWAY_BASE_URL || env.OIDC_ISSUER!, "OIDC_GATEWAY_BASE_URL"),
```

Reuse `normalizedOrigin` so paths, user info, queries, fragments, and non-HTTP(S) values are rejected consistently.

- [ ] **Step 4: Run the configuration test file and verify GREEN**

Run: `npx tsx --test test/config.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the configuration boundary**

```bash
git add server/src/config.ts server/test/config.test.ts
git commit -m "feat: configure OIDC gateway base URL"
```

### Task 2: Route Allowed Compute Requests Through the Gateway Origin

**Files:**
- Modify: `server/src/proxy.ts:102-126`
- Modify: `server/test/proxy.test.ts:30-61`

**Interfaces:**
- Consumes: `OidcConfig.gatewayBaseUrl: URL`
- Produces: allowed proxy requests resolved as `new URL(target, config.gatewayBaseUrl)`

- [ ] **Step 1: Write the failing proxy-target test**

```ts
test("proxy sends allowed compute requests to the configured gateway origin", async () => {
    const gatewayConfig = loadOidcConfig({
        OIDC_ISSUER: "https://issuer.example",
        OIDC_GATEWAY_BASE_URL: "https://cdn.example",
        OIDC_CLIENT_ID: "canvas-client",
        OIDC_CLIENT_SECRET: "client-secret",
        OIDC_SESSION_KEY: Buffer.alloc(32, 7).toString("base64url"),
        OIDC_REQUESTED_SCOPES: "openid llm:grok:grok-imagine-image llm:grok:grok-imagine-image-quality llm:grok:grok-imagine-video llm:grok:grok-imagine-video-1.5 llm:openai:gpt-image-2 llm:openai:gpt-5.6-terra",
        PUBLIC_ORIGIN: "https://canvas.example",
    });
    if (!gatewayConfig) throw new Error("测试 OIDC 配置缺失");
    let upstreamUrl: URL | undefined;
    const app = createApp(gatewayConfig, {
        proxy: { fetch: async (url) => {
            upstreamUrl = new URL(url);
            return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
        } },
    });

    const response = await request(app)
        .post("/api/oidc/proxy/v1/images/generations")
        .set("Origin", "https://canvas.example")
        .set("Cookie", authenticatedCookie(gatewayConfig))
        .send({ model: "gpt-image-2", prompt: "test" });

    assert.equal(response.status, 200);
    assert.equal(upstreamUrl?.origin, "https://cdn.example");
    assert.equal(upstreamUrl?.pathname, "/v1/images/generations");
});
```

Add `import type { OidcConfig } from "../src/config.js";` and update `authenticatedCookie` to accept `activeConfig: OidcConfig = config` so the cookie is sealed using `gatewayConfig.sessionKey`:

```ts
function authenticatedCookie(activeConfig: OidcConfig = config) {
    const session = sealCookie({
        accessToken: "derived-token",
        subject: "subject-1",
        issuer: activeConfig.issuer.origin,
        scopes: activeConfig.scopes,
        createdAt: new Date().toISOString(),
    }, activeConfig.sessionKey);
    return `${sessionCookie.name}=${session}`;
}
```

- [ ] **Step 2: Run the proxy test and verify RED**

Run: `npx tsx --test --test-name-pattern='configured gateway origin' test/proxy.test.ts`

Expected: FAIL because the proxy still resolves the target against `config.issuer`.

- [ ] **Step 3: Resolve proxy targets against the gateway base URL**

```ts
const url = new URL(target, config.gatewayBaseUrl);
```

Do not modify `server/src/oidc.ts`; its issuer and discovery behavior must remain canonical.

- [ ] **Step 4: Run all proxy tests and verify GREEN**

Run: `npx tsx --test test/proxy.test.ts`

Expected: PASS, including bearer injection, route rejection, token invalidation, and retry coverage.

- [ ] **Step 5: Commit the proxy routing change**

```bash
git add server/src/proxy.ts server/test/proxy.test.ts
git commit -m "feat: route OIDC compute proxy through gateway base"
```

### Task 3: Surface the Optional Gateway Origin in Deployment Configuration

**Files:**
- Modify: `server/.env.example`
- Modify: `deploy/knative/service.yaml`
- Modify: `deploy/knative/oidc-secret.example.yaml`
- Modify: `docs/content/docs/overview/docker.mdx`
- Modify: `docs/content/docs/overview/knative.mdx`
- Modify: `docs/content/docs/overview/render.mdx`
- Modify: `docs/content/docs/progress/pending-test.mdx`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: optional `OIDC_GATEWAY_BASE_URL` from server environment or the `infinite-canvas-oidc` Secret.
- Produces: deployment instructions with issuer `https://ai.nekotech.us` and gateway `https://sub2api.tegical.com` as separate fields.

- [ ] **Step 1: Add the optional environment value to templates**

Add this line after `OIDC_ISSUER` in `server/.env.example` and the Knative Secret example:

```text
OIDC_GATEWAY_BASE_URL=https://sub2api.tegical.com
```

Add an `OIDC_GATEWAY_BASE_URL` `secretKeyRef` to the Knative Service container environment. Leave the reference optional so an existing Secret continues to deploy using the issuer fallback.

- [ ] **Step 2: Document the trust boundary and CDN behavior**

State in Docker, Knative, and Render documentation that the issuer remains the OIDC authority, while the gateway base is only for `/v1/*` compute traffic. Document CDN pass-through requirements for bearer authorization, streaming, range requests, and binary media; state that authenticated API responses must not be cached by default.

- [ ] **Step 3: Add a focused manual verification record**

Add a pending-test entry requiring a deployment with issuer `https://ai.nekotech.us` and gateway `https://sub2api.tegical.com`, successful authorization, an allowed model request through the CDN, and unchanged callback/ID Token issuer validation.

- [ ] **Step 4: Update the release note**

Add this `Unreleased` entry:

```text
+ [新增] OIDC 算力渠道支持独立的网关基础地址，可经 CDN 转发模型与媒体请求，同时保持真实 Issuer 的发现和令牌校验。
```

- [ ] **Step 5: Run the focused server verification**

Run: `npx tsx --test test/config.test.ts test/proxy.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit deployment documentation and verification records**

```bash
git add server/.env.example deploy/knative/service.yaml deploy/knative/oidc-secret.example.yaml docs/content/docs/overview/docker.mdx docs/content/docs/overview/knative.mdx docs/content/docs/overview/render.mdx docs/content/docs/progress/pending-test.mdx CHANGELOG.md
git commit -m "docs: configure OIDC gateway CDN deployment"
```
