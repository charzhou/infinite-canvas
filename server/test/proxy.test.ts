import assert from "node:assert/strict";
import test from "node:test";

import request from "supertest";

import { openCookie, sealCookie, sessionCookie } from "../src/cookies.js";
import { loadOidcConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { OidcTokenError } from "../src/oidc.js";

const config = loadOidcConfig({
    OIDC_ISSUER: "https://issuer.example",
    OIDC_CLIENT_ID: "canvas-client",
    OIDC_CLIENT_SECRET: "client-secret",
    OIDC_SESSION_KEY: Buffer.alloc(32, 7).toString("base64url"),
    OIDC_REQUESTED_SCOPES: "openid offline_access llm:grok:grok-imagine-image llm:grok:grok-imagine-image-quality llm:grok:grok-imagine-video llm:grok:grok-imagine-video-1.5 llm:openai:gpt-image-2 llm:openai:gpt-5.6-terra",
    PUBLIC_ORIGIN: "https://canvas.example",
});

if (!config) throw new Error("测试 OIDC 配置缺失");

const gatewayConfig = loadOidcConfig({
    OIDC_ISSUER: "https://issuer.example",
    OIDC_GATEWAY_BASE_URL: "https://cdn.example",
    OIDC_CLIENT_ID: "canvas-client",
    OIDC_CLIENT_SECRET: "client-secret",
    OIDC_SESSION_KEY: Buffer.alloc(32, 9).toString("base64url"),
    OIDC_REQUESTED_SCOPES: "openid offline_access llm:grok:grok-imagine-image llm:grok:grok-imagine-image-quality llm:grok:grok-imagine-video llm:grok:grok-imagine-video-1.5 llm:openai:gpt-image-2 llm:openai:gpt-5.6-terra",
    PUBLIC_ORIGIN: "https://canvas.example",
});

if (!gatewayConfig) throw new Error("测试 OIDC 网关配置缺失");

function authenticatedCookie(activeConfig = config) {
    const session = sealCookie(
        {
            accessToken: "derived-token",
            refreshToken: "refresh-token",
            accessTokenExpiresAt: Date.now() + 900_000,
            refreshTokenExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
            subject: "subject-1",
            issuer: activeConfig.issuer.origin,
            scopes: activeConfig.scopes,
            createdAt: new Date().toISOString(),
        },
        activeConfig.sessionKey,
    );
    return `${sessionCookie.name}=${session}`;
}

test("proxy resolves image generations through the gateway base url", async () => {
    let upstreamOrigin: string | undefined;
    let upstreamPath: string | undefined;
    const app = createApp(gatewayConfig, {
        proxy: {
            fetch: async (url) => {
                const target = new URL(url);
                upstreamOrigin = target.origin;
                upstreamPath = target.pathname;
                return new Response(JSON.stringify({ created: true }), { status: 200, headers: { "Content-Type": "application/json" } });
            },
        },
    });

    const response = await request(app)
        .post("/api/oidc/proxy/v1/images/generations")
        .set("Origin", "https://canvas.example")
        .set("Cookie", authenticatedCookie(gatewayConfig))
        .send({ model: "gpt-image-2", prompt: "test" });

    assert.equal(response.status, 200);
    assert.equal(upstreamOrigin, "https://cdn.example");
    assert.equal(upstreamPath, "/v1/images/generations");
});

test("proxy injects the cookie-derived bearer token and drops browser credentials", async () => {
    let upstreamHeaders: Headers | undefined;
    let upstreamSignal: AbortSignal | null | undefined;
    let dispatcherTimeoutMs: number | undefined;
    const app = createApp(config, {
        proxy: {
            dispatcherFor: (timeoutMs) => {
                dispatcherTimeoutMs = timeoutMs;
                return {};
            },
            fetch: async (_url, init) => {
                upstreamHeaders = new Headers(init?.headers);
                upstreamSignal = init?.signal;
                return new Response(JSON.stringify({ created: true }), { status: 200, headers: { "Content-Type": "application/json" } });
            },
        },
    });

    const response = await request(app)
        .post("/api/oidc/proxy/v1/images/generations")
        .set("Origin", "https://canvas.example")
        .set("Authorization", "Bearer browser-value")
        .set("x-goog-api-key", "browser-value")
        .set("Cookie", authenticatedCookie())
        .send({ model: "gpt-image-2", prompt: "test" });

    assert.equal(response.status, 200);
    assert.equal(upstreamHeaders?.get("authorization"), "Bearer derived-token");
    assert.equal(upstreamHeaders?.get("x-goog-api-key"), null);
    assert.ok(upstreamSignal instanceof AbortSignal);
    assert.equal(dispatcherTimeoutMs, 600_000);
});

test("proxy refreshes an expiring session and rotates its encrypted credentials", async () => {
    let refreshCalls = 0;
    let upstreamAuthorization: string | null | undefined;
    const app = createApp(config, {
        oidc: {
            discoveryFor: async () => ({ issuer: config.issuer.origin, authorization_endpoint: "https://issuer.example/oauth/authorize", token_endpoint: "https://issuer.example/oauth/token", revocation_endpoint: "https://issuer.example/oauth/revoke", jwks_uri: "https://issuer.example/oauth/jwks" }),
            refresh: async (_config, _discovery, refreshToken) => {
                refreshCalls += 1;
                assert.equal(refreshToken, "first-refresh-token");
                return { accessToken: "fresh-derived-token", idToken: "fresh-id-token", refreshToken: "new-refresh-token", expiresIn: 900, refreshTokenExpiresAt: Math.floor(Date.now() / 1000) + 3600, scope: config.scopes.join(" ") };
            },
            verifyIdToken: async () => "subject-1",
        },
        proxy: {
            fetch: async (_url, init) => {
                upstreamAuthorization = new Headers(init?.headers).get("authorization");
                return new Response(JSON.stringify({ created: true }), { status: 200, headers: { "Content-Type": "application/json" } });
            },
        },
    });
    const cookie = `${sessionCookie.name}=${sealCookie({ accessToken: "expired-derived-token", refreshToken: "first-refresh-token", accessTokenExpiresAt: Date.now(), refreshTokenExpiresAt: Date.now() + 60_000, subject: "subject-1", issuer: config.issuer.origin, scopes: config.scopes, createdAt: new Date().toISOString() }, config.sessionKey)}`;

    const response = await request(app).post("/api/oidc/proxy/v1/images/generations").set("Origin", "https://canvas.example").set("Cookie", cookie).send({ model: "gpt-image-2", prompt: "test" });
    const rotated = response.headers["set-cookie"]?.find((value) => value.startsWith(`${sessionCookie.name}=`));
    const value = rotated ? rotated.split(";", 1)[0].split("=", 2)[1] : undefined;
    const session = openCookie<{ accessToken: string; refreshToken: string }>(value, config.sessionKey);

    assert.equal(response.status, 200);
    assert.equal(refreshCalls, 1);
    assert.equal(upstreamAuthorization, "Bearer fresh-derived-token");
    assert.equal(session?.accessToken, "fresh-derived-token");
    assert.equal(session?.refreshToken, "new-refresh-token");
});

test("proxy shares one refresh for concurrent requests from the same browser session", async () => {
    let refreshCalls = 0;
    let startRefresh!: () => void;
    let finishRefresh!: () => void;
    const refreshing = new Promise<void>((resolve) => { startRefresh = resolve; });
    const finished = new Promise<void>((resolve) => { finishRefresh = resolve; });
    const app = createApp(config, {
        oidc: {
            discoveryFor: async () => ({ issuer: config.issuer.origin, authorization_endpoint: "https://issuer.example/oauth/authorize", token_endpoint: "https://issuer.example/oauth/token", revocation_endpoint: "https://issuer.example/oauth/revoke", jwks_uri: "https://issuer.example/oauth/jwks" }),
            refresh: async () => {
                refreshCalls += 1;
                startRefresh();
                await finished;
                return { accessToken: "fresh-derived-token", idToken: "fresh-id-token", refreshToken: "new-refresh-token", expiresIn: 900, refreshTokenExpiresAt: Math.floor(Date.now() / 1000) + 3600, scope: config.scopes.join(" ") };
            },
            verifyIdToken: async () => "subject-1",
        },
        proxy: { fetch: async () => new Response(JSON.stringify({ created: true }), { status: 200, headers: { "Content-Type": "application/json" } }) },
    });
    const cookie = `${sessionCookie.name}=${sealCookie({ accessToken: "expired-derived-token", refreshToken: "old-refresh-token", accessTokenExpiresAt: Date.now(), refreshTokenExpiresAt: Date.now() + 60_000, subject: "subject-1", issuer: config.issuer.origin, scopes: config.scopes, createdAt: new Date().toISOString() }, config.sessionKey)}`;
    const first = request(app).post("/api/oidc/proxy/v1/images/generations").set("Origin", "https://canvas.example").set("Cookie", cookie).send({ model: "gpt-image-2", prompt: "test" }).then((response) => response);
    await refreshing;
    const second = request(app).post("/api/oidc/proxy/v1/images/generations").set("Origin", "https://canvas.example").set("Cookie", cookie).send({ model: "gpt-image-2", prompt: "test" }).then((response) => response);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    finishRefresh();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);

    assert.equal(refreshCalls, 1);
    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
});

test("proxy clears a session when its refresh grant is invalid", async () => {
    const app = createApp(config, {
        oidc: {
            discoveryFor: async () => ({ issuer: config.issuer.origin, authorization_endpoint: "https://issuer.example/oauth/authorize", token_endpoint: "https://issuer.example/oauth/token", revocation_endpoint: "https://issuer.example/oauth/revoke", jwks_uri: "https://issuer.example/oauth/jwks" }),
            refresh: async () => { throw new OidcTokenError("invalid_grant", "refresh token is invalid"); },
        },
    });
    const cookie = `${sessionCookie.name}=${sealCookie({ accessToken: "expired-derived-token", refreshToken: "invalid-refresh-token", accessTokenExpiresAt: Date.now(), refreshTokenExpiresAt: Date.now() + 60_000, subject: "subject-1", issuer: config.issuer.origin, scopes: config.scopes, createdAt: new Date().toISOString() }, config.sessionKey)}`;

    const response = await request(app).post("/api/oidc/proxy/v1/images/generations").set("Origin", "https://canvas.example").set("Cookie", cookie).send({ model: "gpt-image-2", prompt: "test" });

    assert.equal(response.status, 401);
    assert.equal(response.body.code, "oidc_session_invalid");
    assert.equal(response.headers["x-oidc-session-invalid"], "1");
    assert.match(response.headers["set-cookie"].join(";"), /oidc_session=;/);
});

test("proxy clears a session when a refreshed cookie exceeds the browser limit", async () => {
    const app = createApp(config, {
        oidc: {
            discoveryFor: async () => ({ issuer: config.issuer.origin, authorization_endpoint: "https://issuer.example/oauth/authorize", token_endpoint: "https://issuer.example/oauth/token", revocation_endpoint: "https://issuer.example/oauth/revoke", jwks_uri: "https://issuer.example/oauth/jwks" }),
            refresh: async () => ({ accessToken: "x".repeat(4_000), idToken: "fresh-id-token", refreshToken: "new-refresh-token", expiresIn: 900, refreshTokenExpiresAt: Math.floor(Date.now() / 1000) + 3600, scope: config.scopes.join(" ") }),
            verifyIdToken: async () => "subject-1",
        },
    });
    const cookie = `${sessionCookie.name}=${sealCookie({ accessToken: "expired-derived-token", refreshToken: "oversized-refresh-token", accessTokenExpiresAt: Date.now(), refreshTokenExpiresAt: Date.now() + 60_000, subject: "subject-1", issuer: config.issuer.origin, scopes: config.scopes, createdAt: new Date().toISOString() }, config.sessionKey)}`;

    const response = await request(app).post("/api/oidc/proxy/v1/images/generations").set("Origin", "https://canvas.example").set("Cookie", cookie).send({ model: "gpt-image-2", prompt: "test" });

    assert.equal(response.status, 401);
    assert.equal(response.headers["x-oidc-session-invalid"], "1");
    assert.match(response.headers["set-cookie"].join(";"), /oidc_session=;/);
});

test("proxy allows every route used by the approved OIDC models", async () => {
    const upstreamTargets: string[] = [];
    const app = createApp(config, {
        proxy: {
            fetch: async (url) => {
                const target = new URL(url);
                upstreamTargets.push(`${target.pathname}${target.search}`);
                return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
            },
        },
    });

    const calls = [
        { method: "POST", path: "/v1/images/generations" },
        { method: "POST", path: "/v1/images/edits" },
        { method: "POST", path: "/v1/responses" },
        { method: "POST", path: "/v1/videos/generations" },
        { method: "GET", path: "/v1/videos/video-request" },
        { method: "GET", path: "/v1/videos/video-request/content" },
    ] as const;

    for (const call of calls) {
        const response = call.method === "POST"
            ? await request(app).post(`/api/oidc/proxy${call.path}`).set("Origin", "https://canvas.example").set("Cookie", authenticatedCookie()).send({ model: "test" })
            : await request(app).get(`/api/oidc/proxy${call.path}`).set("Cookie", authenticatedCookie());
        assert.equal(response.status, 200, `${call.method} ${call.path}`);
    }

    assert.deepEqual(upstreamTargets, calls.map((call) => call.path));
});

test("proxy rejects management and absolute targets", async () => {
    const app = createApp(config, { proxy: { fetch: async () => new Response(null, { status: 200 }) } });
    const cookie = authenticatedCookie();

    assert.equal((await request(app).get("/api/oidc/proxy/api/v1/users").set("Cookie", cookie)).status, 404);
    assert.equal((await request(app).get("/api/oidc/proxy/https://attacker.example").set("Cookie", cookie)).status, 404);
});

test("proxy clears a session only for an OAuth invalid-token response", async () => {
    const app = createApp(config, {
        proxy: {
            fetch: async () => new Response(JSON.stringify({ error: "invalid_token" }), { status: 401, headers: { "Content-Type": "application/json" } }),
        },
    });

    const response = await request(app).post("/api/oidc/proxy/v1/images/generations").set("Origin", "https://canvas.example").set("Cookie", authenticatedCookie()).send({ model: "gpt-image-2" });

    assert.equal(response.status, 401);
    assert.equal(response.headers["x-oidc-session-invalid"], "1");
    assert.match(response.headers["set-cookie"].join(";"), /oidc_session=;/);
});

test("proxy retries a reset video status request once", async () => {
    let attempts = 0;
    const app = createApp(config, {
        proxy: {
            fetch: async () => {
                attempts++;
                if (attempts === 1) throw new Error("fetch failed", { cause: { code: "ECONNRESET" } });
                return new Response(JSON.stringify({ status: "processing" }), { status: 200, headers: { "Content-Type": "application/json" } });
            },
        },
    });

    const response = await request(app).get("/api/oidc/proxy/v1/videos/video-request").set("Cookie", authenticatedCookie());

    assert.equal(response.status, 200);
    assert.equal(attempts, 2);
});

test("proxy does not retry a reset video generation request", async () => {
    let attempts = 0;
    const app = createApp(config, {
        proxy: {
            fetch: async () => {
                attempts++;
                throw new Error("fetch failed", { cause: { code: "ECONNRESET" } });
            },
        },
    });

    const response = await request(app)
        .post("/api/oidc/proxy/v1/videos/generations")
        .set("Origin", "https://canvas.example")
        .set("Cookie", authenticatedCookie())
        .send({ model: "grok-imagine-video", prompt: "test" });

    assert.equal(response.status, 502);
    assert.equal(attempts, 1);
});
