import { describe, expect, it } from "vitest";

import { boolConfig, createModelChannel, defaultConfig, importSub2ApiChannel, normalizeAiConfig, removeOidcChannel, resolveModelRequestConfig, selectableModelsByCapability, type AiConfig, type ModelChannel } from "./use-config-store";

const configWithOidcGrokVideo = {
    channels: [
        { id: "sub2api", name: "My Compute", baseUrl: "/api/oidc/proxy", apiKey: "", apiFormat: "openai", authMode: "oidc", providerId: "sub2api", models: [{ name: "grok-imagine-video", capability: "video", apiFormat: "xai" }] },
    ],
} as unknown as AiConfig;

const sub2ApiChannel = {
    id: "sub2api",
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
    expect(resolveModelRequestConfig(configWithOidcGrokVideo, "sub2api::grok-imagine-video").apiFormat).toBe("xai");
});

it("keeps the managed Sub2API provider on resolved model config", () => {
    const config = { ...configWithOidcGrokVideo, channels: [createModelChannel(sub2ApiChannel)] } as AiConfig;
    expect(resolveModelRequestConfig(config, "sub2api::grok-imagine-video").providerId).toBe("sub2api");
});

it("removes only the managed channel when its BFF session becomes invalid", () => {
    const config = { ...configWithOidcGrokVideo, channels: [{ id: "manual-audio", name: "音频", baseUrl: "https://audio.example", apiKey: "key", apiFormat: "openai", models: [{ name: "tts", capability: "audio" }] }, ...configWithOidcGrokVideo.channels] };
    expect(removeOidcChannel(config as unknown as AiConfig).channels.map((channel) => channel.id)).toEqual(["manual-audio"]);
});

it("keeps a manual Sub2API channel when no OIDC session exists", () => {
    const config = importSub2ApiChannel(defaultConfig, { apiKey: "sk-test", descriptor: { channelId: "tenant-a" }, models: [{ name: "gpt-5.6-terra", capability: "text" }] });
    expect(removeOidcChannel(config).channels.some((channel) => channel.id === "sub2api")).toBe(true);
});

it("hides models from manual channels without an API key", () => {
    const config = {
        ...configWithOidcGrokVideo,
        models: ["empty::gpt-image-2", "ready::gpt-image-2", "sub2api::grok-imagine-video"],
        channels: [
            { id: "empty", name: "默认渠道", baseUrl: "https://api.openai.com", apiKey: "", apiFormat: "openai", models: [{ name: "gpt-image-2", capability: "image" }] },
            { id: "ready", name: "已配置渠道", baseUrl: "https://api.example.com", apiKey: "key", apiFormat: "openai", models: [{ name: "gpt-image-2", capability: "image" }] },
            ...configWithOidcGrokVideo.channels,
        ],
    } as unknown as AiConfig;

    expect(selectableModelsByCapability(config)).toEqual(["ready::gpt-image-2", "sub2api::grok-imagine-video"]);
});

it("adds a Sub2API manual channel with the fixed gateway and requested defaults", () => {
    const result = importSub2ApiChannel(defaultConfig, { apiKey: "sk-test", descriptor: { channelId: "tenant-a", defaults: { text: "gpt-5.6-terra" } }, models: [{ name: "gpt-5.6-terra", capability: "text" }] });

    expect(result.channels.find((channel) => channel.id === "sub2api")).toMatchObject({ baseUrl: "https://sub2api.tegical.com", apiKey: "sk-test", authMode: "manual", providerId: "sub2api" });
    expect(result.textModel).toBe("sub2api::gpt-5.6-terra");
});

const configWithManualTenantAndOidc = {
    ...defaultConfig,
    channels: [
        { id: "tenant-a", name: "旧 Tenant", baseUrl: "https://old.example", apiKey: "old-key", apiFormat: "openai", authMode: "manual", models: [{ name: "old-model", capability: "text" }] },
        { id: "sub2api", name: "受管理", baseUrl: "/api/oidc/proxy", apiKey: "", apiFormat: "openai", authMode: "oidc", providerId: "sub2api", models: [{ name: "gpt-5.6-terra", capability: "text" }] },
    ],
} as AiConfig;
const importInput = { apiKey: "sk-test", descriptor: { channelId: "tenant-a", name: "Tenant A" }, models: [{ name: "gpt-5.6-terra", capability: "text" as const }] };

it("replaces the existing Sub2API channel without touching ordinary channels", () => {
    const result = importSub2ApiChannel(configWithManualTenantAndOidc, importInput);

    expect(result.channels.map((channel) => channel.id)).toEqual(["tenant-a", "sub2api"]);
    expect(result.channels[1].apiKey).toBe("sk-test");
});

it("uses the fixed Sub2API channel ID when replacing OIDC", () => {
    const result = importSub2ApiChannel(configWithOidcGrokVideo, importInput);
    expect(result.channels).toHaveLength(1);
    expect(result.channels[0]).toMatchObject({ id: "sub2api", authMode: "manual", providerId: "sub2api" });
});

it("normalizes imported config to one fixed Sub2API channel", () => {
    const duplicate = { ...configWithManualTenantAndOidc, channels: [...configWithManualTenantAndOidc.channels, { ...sub2ApiChannel, id: "legacy-sub2api" }] } as AiConfig;
    const result = normalizeAiConfig(duplicate);
    expect(result.channels.filter((channel) => channel.providerId === "sub2api")).toHaveLength(1);
    expect(result.channels.find((channel) => channel.providerId === "sub2api")?.id).toBe("sub2api");
});

it("keeps the declared xAI format and Sub2API adapter after import", () => {
    const result = importSub2ApiChannel(defaultConfig, { apiKey: "sk-test", descriptor: { channelId: "tenant-a" }, models: [{ name: "grok-imagine-video", capability: "video", apiFormat: "xai" }] });

    expect(resolveModelRequestConfig(result, "sub2api::grok-imagine-video")).toMatchObject({ apiFormat: "xai", providerId: "sub2api" });
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
