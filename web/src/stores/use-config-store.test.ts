import { describe, expect, it } from "vitest";

import { removeOidcChannel, resolveModelRequestConfig, selectableModelsByCapability, type AiConfig } from "./use-config-store";

const configWithOidcGrokVideo = {
    channels: [
        { id: "oidc", name: "My Compute", baseUrl: "/api/oidc/proxy", apiKey: "", apiFormat: "openai", authMode: "oidc", models: [{ name: "grok-imagine-video", capability: "video", apiFormat: "xai" }] },
    ],
} as unknown as AiConfig;

it("uses a model api format over the managed channel default", () => {
    expect(resolveModelRequestConfig(configWithOidcGrokVideo, "oidc::grok-imagine-video").apiFormat).toBe("xai");
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
