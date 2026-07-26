import assert from "node:assert/strict";
import test from "node:test";

import { loadOidcConfig } from "../src/config.js";

const approvedScopes = [
    "openid",
    "offline_access",
    "llm:grok:grok-imagine-image",
    "llm:grok:grok-imagine-image-quality",
    "llm:grok:grok-imagine-video",
    "llm:grok:grok-imagine-video-1.5",
    "llm:openai:gpt-image-2",
    "llm:openai:gpt-5.6-terra",
].join(" ");

const testEnv = {
    OIDC_ISSUER: "https://issuer.example/",
    OIDC_CLIENT_ID: "canvas-client",
    OIDC_CLIENT_SECRET: "client-secret",
    OIDC_SESSION_KEY: Buffer.alloc(32, 7).toString("base64url"),
    OIDC_PROVIDER_NAME: "My Compute",
    OIDC_REQUESTED_SCOPES: approvedScopes,
    PUBLIC_ORIGIN: "https://canvas.example/",
};

test("loads the approved exact scopes into protocol and capability metadata", () => {
    const config = loadOidcConfig(testEnv);

    assert.deepEqual(
        config?.models.map(({ name, apiFormat, capability }) => ({ name, apiFormat, capability })),
        [
            { name: "grok-imagine-image", apiFormat: "xai", capability: "image" },
            { name: "grok-imagine-image-quality", apiFormat: "xai", capability: "image" },
            { name: "grok-imagine-video", apiFormat: "xai", capability: "video" },
            { name: "grok-imagine-video-1.5", apiFormat: "xai", capability: "video" },
            { name: "gpt-image-2", apiFormat: "openai", capability: "image" },
            { name: "gpt-5.6-terra", apiFormat: "openai", capability: "text" },
        ],
    );
    assert.equal(config?.providerName, "My Compute");
    assert.equal(config?.issuer.toString(), "https://issuer.example/");
    assert.equal(config?.gatewayBaseUrl?.toString(), "https://issuer.example/");
    assert.equal(config?.proxyTimeoutMs, 600_000);
});

test("loads OIDC gateway base url when configured", () => {
    const config = loadOidcConfig({ ...testEnv, OIDC_GATEWAY_BASE_URL: "https://cdn.example/" });

    assert.equal(config?.gatewayBaseUrl.toString(), "https://cdn.example/");
});

test("falls back to issuer for missing OIDC gateway base url", () => {
    const config = loadOidcConfig(testEnv);

    assert.equal(config?.gatewayBaseUrl.toString(), "https://issuer.example/");
});

test("rejects gateway base url paths", () => {
    assert.throws(() => loadOidcConfig({ ...testEnv, OIDC_GATEWAY_BASE_URL: "https://cdn.example/v1" }));
});

test("rejects bare, wildcard, duplicate openid, and unsupported model scopes", () => {
    for (const scope of [
        "openid offline_access llm",
        "openid offline_access llm:openai:*",
        "openid offline_access openid llm:openai:gpt-image-2",
        "openid offline_access llm:openai:gpt-4.1",
    ]) {
        assert.throws(() => loadOidcConfig({ ...testEnv, OIDC_REQUESTED_SCOPES: scope }));
    }
});

test("accepts offline access and a configured subset of mapped model scopes", () => {
    const config = loadOidcConfig({
        ...testEnv,
        OIDC_REQUESTED_SCOPES: "openid offline_access llm:openai:gpt-image-2",
    });

    assert.deepEqual(config?.scopes, ["openid", "offline_access", "llm:openai:gpt-image-2"]);
    assert.deepEqual(config?.models.map((model) => model.name), ["gpt-image-2"]);
});

test("does not enable OIDC when deployment values are absent", () => {
    assert.equal(loadOidcConfig({}), null);
});
