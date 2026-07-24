import assert from "node:assert/strict";
import test from "node:test";

import { parse as parseCookie } from "cookie";
import request from "supertest";

import { transactionCookie } from "../src/cookies.js";
import { loadOidcConfig } from "../src/config.js";
import { createApp } from "../src/app.js";

const scopes = [
    "openid",
    "llm:grok:grok-imagine-image",
    "llm:grok:grok-imagine-image-quality",
    "llm:grok:grok-imagine-video",
    "llm:grok:grok-imagine-video-1.5",
    "llm:openai:gpt-image-2",
    "llm:openai:gpt-5.6-terra",
].join(" ");

const config = loadOidcConfig({
    OIDC_ISSUER: "https://issuer.example",
    OIDC_CLIENT_ID: "canvas-client",
    OIDC_CLIENT_SECRET: "client-secret",
    OIDC_SESSION_KEY: Buffer.alloc(32, 7).toString("base64url"),
    OIDC_PROVIDER_NAME: "My Compute",
    OIDC_REQUESTED_SCOPES: scopes,
    PUBLIC_ORIGIN: "https://canvas.example",
});

if (!config) throw new Error("测试 OIDC 配置缺失");

const discovery = {
    issuer: "https://issuer.example",
    authorization_endpoint: "https://issuer.example/oauth/authorize",
    token_endpoint: "https://issuer.example/oauth/token",
    revocation_endpoint: "https://issuer.example/oauth/revoke",
    jwks_uri: "https://issuer.example/oauth/jwks",
};

function cookiePair(response: request.Response, name?: string) {
    const value = response.headers["set-cookie"]?.find((item) => !name || item.startsWith(`${name}=`));
    if (!value) throw new Error("响应未设置 Cookie");
    return value.split(";", 1)[0];
}

function createTestApp() {
    let exchangeCalls = 0;
    let revokeCalls = 0;
    const app = createApp(config, {
        oidc: {
            discoveryFor: async () => discovery,
            exchangeCode: async () => {
                exchangeCalls += 1;
                return { accessToken: "derived-token", idToken: "id-token", scope: scopes };
            },
            verifyIdToken: async () => "subject-1",
            revoke: async () => {
                revokeCalls += 1;
            },
        },
    });
    return { app, getExchangeCalls: () => exchangeCalls, getRevokeCalls: () => revokeCalls };
}

test("authorize stores state and nonce only in an encrypted transaction cookie", async () => {
    const { app } = createTestApp();
    const response = await request(app).post("/api/oidc/authorize").send({ returnTo: "/config" });

    assert.equal(response.status, 200);
    assert.match(response.body.authorizationUrl, /^https:\/\/issuer\.example\/oauth\/authorize\?/);
    assert.match(response.headers["set-cookie"].join(";"), /HttpOnly/);
    assert.doesNotMatch(response.headers["set-cookie"].join(";"), /derived-token/);
    assert.equal(parseCookie(cookiePair(response))[transactionCookie.name]?.includes("."), true);
});

test("callback rejects a mismatched state without exchanging the authorization code", async () => {
    const { app, getExchangeCalls } = createTestApp();
    const authorization = await request(app).post("/api/oidc/authorize").send({ returnTo: "/config" });
    const response = await request(app).get("/api/oidc/callback?code=code-1&state=wrong").set("Cookie", cookiePair(authorization));

    assert.equal(response.status, 302);
    assert.equal(getExchangeCalls(), 0);
});

test("session endpoints return capability metadata but never the derived token", async () => {
    const { app } = createTestApp();
    const authorization = await request(app).post("/api/oidc/authorize").send({ returnTo: "/config" });
    const transaction = parseCookie(cookiePair(authorization))[transactionCookie.name];
    const payload = transaction ? (await import("../src/cookies.js")).openCookie<{ state: string }>(transaction, config.sessionKey) : null;
    if (!payload) throw new Error("无法读取测试事务 Cookie");
    const callback = await request(app).get(`/api/oidc/callback?code=code-1&state=${encodeURIComponent(payload.state)}`).set("Cookie", cookiePair(authorization));
    const sessionCookie = cookiePair(callback, "oidc_session");

    const session = await request(app).get("/api/oidc/session").set("Cookie", sessionCookie);
    const models = await request(app).get("/api/oidc/models").set("Cookie", sessionCookie);

    assert.deepEqual(session.body, { connected: true, providerName: "My Compute", approvedScopes: scopes.split(" ") });
    assert.equal(JSON.stringify(session.body).includes("derived-token"), false);
    assert.equal(models.body.some((model: { name: string }) => model.name === "gpt-image-2"), true);
});

test("disconnect always clears the browser session after requesting upstream revocation", async () => {
    const { app, getRevokeCalls } = createTestApp();
    const authorization = await request(app).post("/api/oidc/authorize").send({ returnTo: "/config" });
    const transaction = parseCookie(cookiePair(authorization))[transactionCookie.name];
    const payload = transaction ? (await import("../src/cookies.js")).openCookie<{ state: string }>(transaction, config.sessionKey) : null;
    if (!payload) throw new Error("无法读取测试事务 Cookie");
    const callback = await request(app).get(`/api/oidc/callback?code=code-1&state=${encodeURIComponent(payload.state)}`).set("Cookie", cookiePair(authorization));

    const response = await request(app).delete("/api/oidc/session").set("Cookie", cookiePair(callback, "oidc_session"));

    assert.equal(response.status, 204);
    assert.equal(getRevokeCalls(), 1);
    assert.match(response.headers["set-cookie"].join(";"), /oidc_session=;/);
});
