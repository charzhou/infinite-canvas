import { expect, it, vi } from "vitest";

vi.mock("axios", () => ({ default: { post: vi.fn(), get: vi.fn(), isCancel: vi.fn() } }));

import axios from "axios";

import { createVideoGenerationTask, pollVideoGenerationTask, videoPollDelay, videoPollTimeoutMs } from "./video";
import { defaultConfig, type AiConfig } from "@/stores/use-config-store";

const oidcXaiConfig = {
    ...defaultConfig,
    model: "oidc::grok-imagine-video",
    videoModel: "oidc::grok-imagine-video",
    channels: [{ id: "oidc", name: "Sub2API", baseUrl: "/api/oidc/proxy", apiKey: "", apiFormat: "openai", authMode: "oidc", providerId: "sub2api", models: [{ name: "grok-imagine-video", capability: "video", apiFormat: "xai" }] }],
} as AiConfig;

const sub2ApiOpenAiConfig = {
    ...defaultConfig,
    model: "oidc::video-model",
    videoModel: "oidc::video-model",
    channels: [{ id: "oidc", name: "Sub2API", baseUrl: "/api/oidc/proxy", apiKey: "", apiFormat: "openai", authMode: "oidc", providerId: "sub2api", models: [{ name: "video-model", capability: "video" }] }],
} as AiConfig;

const genericXaiConfig = {
    ...oidcXaiConfig,
    channels: [{ ...oidcXaiConfig.channels[0], providerId: undefined }],
} as AiConfig;

it("increases pending video polling delays exponentially with a cap", () => {
    expect(videoPollDelay(0)).toBe(5000);
    expect(videoPollDelay(1)).toBe(10000);
    expect(videoPollDelay(4)).toBe(60000);
});

it("uses the same extended timeout for every video task", () => {
    expect(videoPollTimeoutMs()).toBe(1800000);
});

it("allows an OIDC xAI video model without a browser API key", async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: { request_id: "video-request" } });

    await expect(createVideoGenerationTask(oidcXaiConfig, "测试视频")).resolves.toMatchObject({ provider: "xai", id: "video-request", adapter: "sub2api" });
    expect(axios.post).toHaveBeenCalledWith(
        "/api/oidc/proxy/v1/videos/generations",
        { model: "grok-imagine-video", prompt: "测试视频", duration: 6, aspect_ratio: "16:9", resolution: "720p", preset: "normal" },
        { headers: { Authorization: "Bearer ", "Content-Type": "application/json" }, signal: undefined },
    );
});

it("uses the Sub2API xAI reference images field for multiple references", async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: { request_id: "video-request" } });
    const image = { id: "image-1", name: "ref.png", type: "image/png", dataUrl: "data:image/png;base64,AA==" };

    await createVideoGenerationTask(oidcXaiConfig, "测试视频", [image, { ...image, id: "image-2" }]);

    const payload = vi.mocked(axios.post).mock.lastCall?.[1];
    expect(payload).toMatchObject({ duration: 6, aspect_ratio: "16:9", resolution: "720p", reference_images: [{ url: image.dataUrl }, { url: image.dataUrl }] });
    expect(payload).not.toHaveProperty("images");
});

it("uses a JSON OpenAI video payload for Sub2API", async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: { id: "video-task" } });
    const image = { id: "image-1", name: "ref.png", type: "image/png", dataUrl: "data:image/png;base64,AA==" };

    await expect(createVideoGenerationTask(sub2ApiOpenAiConfig, "测试视频", [image])).resolves.toEqual({ id: "video-task", provider: "openai", model: "oidc::video-model", adapter: "sub2api" });
    expect(axios.post).toHaveBeenCalledWith(
        "/api/oidc/proxy/v1/videos",
        { model: "video-model", prompt: "测试视频", seconds: "6", size: "1280x720", preset: "normal", input_reference: [{ type: "image", image_url: image.dataUrl }] },
        { headers: { Authorization: "Bearer ", "Content-Type": "application/json" }, signal: undefined },
    );
});

it("keeps generic xAI multiple reference behavior unchanged", async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: { request_id: "video-request" } });
    const image = { id: "image-1", name: "ref.png", type: "image/png", dataUrl: "data:image/png;base64,AA==" };

    await expect(createVideoGenerationTask(genericXaiConfig, "测试视频", [image, { ...image, id: "image-2" }])).resolves.toEqual({ id: "video-request", provider: "xai", model: "oidc::grok-imagine-video" });

    const payload = vi.mocked(axios.post).mock.lastCall?.[1];
    expect(payload).toMatchObject({ images: [{ url: image.dataUrl }, { url: image.dataUrl }] });
    expect(payload).not.toHaveProperty("reference_images");
});

it("downloads a completed xAI video through the channel content endpoint", async () => {
    const content = new Blob(["video"], { type: "video/mp4" });
    vi.mocked(axios.get)
        .mockResolvedValueOnce({ data: { status: "done", video: { url: "https://expired.example/video.mp4" } } })
        .mockResolvedValueOnce({ data: content });

    const state = await pollVideoGenerationTask(oidcXaiConfig, { id: "video-request", provider: "xai", model: "oidc::grok-imagine-video" });

    expect(state).toEqual({ status: "completed", result: { blob: content } });
    expect(axios.get).toHaveBeenNthCalledWith(1, "/api/oidc/proxy/v1/videos/video-request", { headers: { Authorization: "Bearer " }, signal: undefined });
    expect(axios.get).toHaveBeenNthCalledWith(2, "/api/oidc/proxy/v1/videos/video-request/content", { headers: { Authorization: "Bearer " }, responseType: "blob", signal: undefined });
});

it("treats the provider completed status as an xAI video result", async () => {
    const content = new Blob(["video"], { type: "video/mp4" });
    vi.mocked(axios.get)
        .mockResolvedValueOnce({ data: { status: "completed", video: { url: "https://expired.example/video.mp4" } } })
        .mockResolvedValueOnce({ data: content });

    await expect(pollVideoGenerationTask(oidcXaiConfig, { id: "video-request", provider: "xai", model: "oidc::grok-imagine-video" }))
        .resolves.toEqual({ status: "completed", result: { blob: content } });
});
