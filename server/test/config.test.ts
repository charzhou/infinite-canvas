import assert from "node:assert/strict";
import test from "node:test";

import { loadOidcConfig, modelCatalog, parseScopes, scopeModels, scopesForModelIds } from "../src/config.js";

const testEnv = {
    OIDC_ISSUER: "https://issuer.example/",
    OIDC_CLIENT_ID: "canvas-client",
    OIDC_CLIENT_SECRET: "client-secret",
    OIDC_SESSION_KEY: Buffer.alloc(32, 7).toString("base64url"),
    OIDC_PROVIDER_NAME: "My Compute",
    PUBLIC_ORIGIN: "https://canvas.example/",
};

test("loads deployment config and the static model catalog", () => {
    const config = loadOidcConfig(testEnv);

    assert.deepEqual(
        modelCatalog().map(({ name, apiFormat, capability }) => ({ name, apiFormat, capability })),
        [
            { name: "grok-imagine-image", apiFormat: "xai", capability: "image" },
            { name: "grok-imagine-image-quality", apiFormat: "xai", capability: "image" },
            { name: "grok-imagine-video", apiFormat: "xai", capability: "video" },
            { name: "grok-imagine-video-1.5", apiFormat: "xai", capability: "video" },
            { name: "gpt-image-2", apiFormat: "openai", capability: "image" },
            { name: "seedance-2-0", apiFormat: "openai", capability: "video" },
            { name: "seedance-2-0-mini", apiFormat: "openai", capability: "video" },
            { name: "seedance-2-0-fast", apiFormat: "openai", capability: "video" },
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

test("validates granted scopes against the static model catalog", () => {
    for (const scope of [
        "openid offline_access llm",
        "openid offline_access llm:openai:*",
        "openid offline_access openid llm:openai:gpt-image-2",
        "openid offline_access llm:openai:gpt-4.1",
    ]) {
        assert.throws(() => parseScopes(scope));
    }
});

test("maps selected catalog IDs to exact requested scopes", () => {
    const scopes = scopesForModelIds(["openai/gpt-image-2", "openai/seedance-2-0", "grok/grok-imagine-video"]);

    assert.deepEqual(scopes, ["openid", "offline_access", "llm:openai:gpt-image-2", "llm:openai:seedance-2-0", "llm:grok:grok-imagine-video"]);
    assert.deepEqual(scopeModels(scopes).map((model) => model.name), ["grok-imagine-video", "gpt-image-2", "seedance-2-0"]);
    assert.throws(() => scopesForModelIds(["unknown/model"]));
});

test("does not enable OIDC when deployment values are absent", () => {
    assert.equal(loadOidcConfig({}), null);
});
