import assert from "node:assert/strict";
import test from "node:test";

import request from "supertest";

import { sealCookie, sessionCookie } from "../src/cookies.js";
import { loadOidcConfig } from "../src/config.js";
import { createApp } from "../src/app.js";

const config = loadOidcConfig({
    OIDC_ISSUER: "https://issuer.example",
    OIDC_CLIENT_ID: "canvas-client",
    OIDC_CLIENT_SECRET: "client-secret",
    OIDC_SESSION_KEY: Buffer.alloc(32, 7).toString("base64url"),
    OIDC_REQUESTED_SCOPES: "openid llm:grok:grok-imagine-image llm:grok:grok-imagine-image-quality llm:grok:grok-imagine-video llm:grok:grok-imagine-video-1.5 llm:openai:gpt-image-2 llm:openai:gpt-5.6-terra",
    PUBLIC_ORIGIN: "https://canvas.example",
});

if (!config) throw new Error("测试 OIDC 配置缺失");

function authenticatedCookie() {
    const session = sealCookie(
        {
            accessToken: "derived-token",
            subject: "subject-1",
            issuer: config.issuer.origin,
            scopes: config.scopes,
            createdAt: new Date().toISOString(),
        },
        config.sessionKey,
    );
    return `${sessionCookie.name}=${session}`;
}

test("proxy injects the cookie-derived bearer token and drops browser credentials", async () => {
    let upstreamHeaders: Headers | undefined;
    const app = createApp(config, {
        proxy: {
            fetch: async (_url, init) => {
                upstreamHeaders = new Headers(init?.headers);
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
