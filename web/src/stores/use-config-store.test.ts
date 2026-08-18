import { describe, expect, it } from "vitest";

import { boolConfig, createModelChannel, defaultConfig, importSub2ApiChannel, removeOidcChannel, resolveModelRequestConfig, selectableModelsByCapability, type AiConfig, type ModelChannel } from "./use-config-store";

const configWithOidcGrokVideo = {
    channels: [
        { id: "oidc", name: "My Compute", baseUrl: "/api/oidc/proxy", apiKey: "", apiFormat: "openai", authMode: "oidc", models: [{ name: "grok-imagine-video", capability: "video", apiFormat: "xai" }] },
    ],
} as unknown as AiConfig;

const sub2ApiChannel = {
    id: "oidc",
    name: "算力渠道",
    baseUrl: "/api/oidc/proxy",
    apiKey: "",
    apiFormat: "openai",
    authMode: "oidc",
    providerId: "sub2api",
    models: [{ name: "grok-imagine-video", capability: "video", apiFormat: "xai" }],
} satisfies ModelChannel;

it("parses persisted boolean config values with a fallback", () => {
    expect(boolConfig("true", false)).toBe(true);
    expect(boolConfig("false", true)).toBe(false);
    expect(boolConfig("", true)).toBe(true);
});

it("uses a model api format over the managed channel default", () => {
    expect(resolveModelRequestConfig(configWithOidcGrokVideo, "oidc::grok-imagine-video").apiFormat).toBe("xai");
});

it("keeps the managed Sub2API provider on resolved model config", () => {
    const config = { ...configWithOidcGrokVideo, channels: [createModelChannel(sub2ApiChannel)] } as AiConfig;
    expect(resolveModelRequestConfig(config, "oidc::grok-imagine-video").providerId).toBe("sub2api");
});

it("removes only the managed channel when its BFF session becomes invalid", () => {
    const config = { ...configWithOidcGrokVideo, channels: [{ id: "manual-audio", name: "音频", baseUrl: "https://audio.example", apiKey: "key", apiFormat: "openai", models: [{ name: "tts", capability: "audio" }] }, ...configWithOidcGrokVideo.channels] };
    expect(removeOidcChannel(config as unknown as AiConfig).channels.map((channel) => channel.id)).toEqual(["manual-audio"]);
});

it("hides models from manual channels without an API key", () => {
    const config = {
        ...configWithOidcGrokVideo,
        models: ["empty::gpt-image-2", "ready::gpt-image-2", "oidc::grok-imagine-video"],
        channels: [
            { id: "empty", name: "默认渠道", baseUrl: "https://api.openai.com", apiKey: "", apiFormat: "openai", models: [{ name: "gpt-image-2", capability: "image" }] },
            { id: "ready", name: "已配置渠道", baseUrl: "https://api.example.com", apiKey: "key", apiFormat: "openai", models: [{ name: "gpt-image-2", capability: "image" }] },
            ...configWithOidcGrokVideo.channels,
        ],
    } as unknown as AiConfig;

    expect(selectableModelsByCapability(config)).toEqual(["ready::gpt-image-2", "oidc::grok-imagine-video"]);
});

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

it("keeps the declared xAI format and Sub2API adapter after import", () => {
    const result = importSub2ApiChannel(defaultConfig, { apiKey: "sk-test", descriptor: { channelId: "tenant-a" }, models: [{ name: "grok-imagine-video", capability: "video", apiFormat: "xai" }] });

    expect(resolveModelRequestConfig(result, "tenant-a::grok-imagine-video")).toMatchObject({ apiFormat: "xai", providerId: "sub2api" });
});

it("rejects a descriptor default that does not match the imported model capability", () => {
    expect(() =>
        importSub2ApiChannel(defaultConfig, {
            apiKey: "sk-test",
            descriptor: { channelId: "tenant-a", defaults: { video: "gpt-5.6-terra" } },
            models: [{ name: "gpt-5.6-terra", capability: "text" }],
        }),
    ).toThrow("默认模型不可用");
});
