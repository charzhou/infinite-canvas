import { expect, it, vi } from "vitest";

vi.mock("axios", () => ({ default: { post: vi.fn(), get: vi.fn(), isCancel: vi.fn() } }));

import axios from "axios";

import { createVideoGenerationTask } from "./video";
import { defaultConfig, type AiConfig } from "@/stores/use-config-store";

it("allows an OIDC xAI video model without a browser API key", async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: { request_id: "video-request" } });
    const config = {
        ...defaultConfig,
        model: "oidc::grok-imagine-video",
        videoModel: "oidc::grok-imagine-video",
        channels: [{ id: "oidc", name: "Sub2API", baseUrl: "/api/oidc/proxy", apiKey: "", apiFormat: "openai", authMode: "oidc", models: [{ name: "grok-imagine-video", capability: "video", apiFormat: "xai" }] }],
    } as AiConfig;

    await expect(createVideoGenerationTask(config, "测试视频")).resolves.toMatchObject({ provider: "xai", id: "video-request" });
});
