import { describe, expect, it } from "vitest";

import { removeOidcChannel, resolveModelRequestConfig, type AiConfig } from "./use-config-store";

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
