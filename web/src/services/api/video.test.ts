import { beforeEach, expect, it, vi } from "vitest";

const { storeMediaFile, uploadMediaFile, getMediaBlob, getImageBlob } = vi.hoisted(() => ({
    storeMediaFile: vi.fn(async () => ({ url: "blob:stored", storageKey: "video:stored", bytes: 5, mimeType: "video/mp4" })),
    uploadMediaFile: vi.fn(async () => ({ url: "blob:metadata", storageKey: "video:metadata", bytes: 5, mimeType: "video/mp4", width: 1280, height: 720 })),
    getMediaBlob: vi.fn(async () => new Blob(["media"], { type: "video/mp4" })),
    getImageBlob: vi.fn(async () => new Blob(["image"], { type: "image/png" })),
}));

vi.mock("axios", () => ({ default: { post: vi.fn(), get: vi.fn(), isCancel: vi.fn(), isAxiosError: vi.fn(() => false) } }));
vi.mock("@/services/file-storage", () => ({ storeMediaFile, uploadMediaFile, getMediaBlob }));
vi.mock("@/services/image-storage", async () => {
    const actual = await vi.importActual<typeof import("@/services/image-storage")>("@/services/image-storage");
    return { ...actual, getImageBlob };
});

import axios from "axios";

import { isSeedanceModel } from "./sub2api-video";
import { createVideoGenerationTask, pollVideoGenerationTask, storeGeneratedVideo, videoPollDelay, videoPollTimeoutMs } from "./video";
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

it("treats Seedance 2.5 as a Sub2API Seedance model", () => {
    expect(isSeedanceModel("seedance-2.5")).toBe(true);
});

const sub2ApiSeedanceConfig = {
    ...defaultConfig,
    model: "oidc::seedance-2.0",
    videoModel: "oidc::seedance-2.0",
    channels: [{ id: "oidc", name: "Sub2API", baseUrl: "/api/oidc/proxy", apiKey: "", apiFormat: "openai", authMode: "oidc", providerId: "sub2api", models: [{ name: "seedance-2.0", capability: "video" }] }],
} as AiConfig;

const genericXaiConfig = {
    ...oidcXaiConfig,
    channels: [{ ...oidcXaiConfig.channels[0], providerId: undefined }],
} as AiConfig;

beforeEach(() => vi.clearAllMocks());

it("increases pending video polling delays exponentially with a cap", () => {
    expect(videoPollDelay(0)).toBe(5000);
    expect(videoPollDelay(1)).toBe(10000);
    expect(videoPollDelay(4)).toBe(30000);
});

it("uses the same extended timeout for every video task", () => {
    expect(videoPollTimeoutMs()).toBe(3600000);
});

it("stores a completed workbench video without waiting for media metadata", async () => {
    const result = await storeGeneratedVideo({ blob: new Blob(["video"], { type: "video/mp4" }) }, { readMetadata: false });

    expect(result).toEqual({ url: "blob:stored", storageKey: "video:stored", bytes: 5, mimeType: "video/mp4" });
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

it("uses every image for Sub2API xAI multi-image reference mode", async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: { request_id: "video-request" } });
    const image = { id: "image-1", name: "ref.png", type: "image/png", dataUrl: "data:image/png;base64,AA==" };

    await createVideoGenerationTask({ ...oidcXaiConfig, videoMode: "reference" }, "测试视频", [image, { ...image, id: "image-2" }]);

    const payload = vi.mocked(axios.post).mock.lastCall?.[1];
    expect(payload).toMatchObject({ duration: 6, aspect_ratio: "16:9", resolution: "720p", reference_images: [{ url: image.dataUrl }, { url: image.dataUrl }] });
    expect(payload).not.toHaveProperty("images");
});

it("uses only the first image for Sub2API xAI first-frame mode", async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: { request_id: "video-request" } });
    const image = { id: "image-1", name: "first.png", type: "image/png", dataUrl: "data:image/png;base64,AA==" };
    const secondImage = { ...image, id: "image-2", dataUrl: "data:image/png;base64,BB==" };

    await createVideoGenerationTask(oidcXaiConfig, "测试视频", [image, secondImage]);

    const payload = vi.mocked(axios.post).mock.lastCall?.[1];
    expect(payload).toMatchObject({ image: { url: image.dataUrl } });
    expect(payload).not.toHaveProperty("reference_images");
});

it("uses a JSON OpenAI video payload for Sub2API", async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: { id: "video-task" } });
    const image = { id: "image-1", name: "ref.png", type: "image/png", dataUrl: "[image omitted]" };

    await expect(createVideoGenerationTask(sub2ApiOpenAiConfig, "测试视频", [image])).resolves.toEqual({ id: "video-task", provider: "openai", model: "oidc::video-model", adapter: "sub2api" });
    expect(axios.post).toHaveBeenCalledWith(
        "/api/oidc/proxy/v1/videos",
        { model: "video-model", prompt: "测试视频", seconds: "6", size: "1280x720", preset: "normal", input_reference: [{ type: "image", image_url: image.dataUrl }] },
        { headers: { Authorization: "Bearer ", "Content-Type": "application/json" }, signal: undefined },
    );
});

it("uses the Cangyuan JSON video payload for Sub2API Seedance", async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: { id: "video-task" } });
    const image = { id: "image-1", name: "ref.png", type: "image/png", url: "https://assets.example.com/ref.png", dataUrl: "" };

    await expect(createVideoGenerationTask(sub2ApiSeedanceConfig, "测试视频", [image])).resolves.toEqual({ id: "video-task", provider: "openai", model: "oidc::seedance-2.0", adapter: "sub2api" });
    expect(axios.post).toHaveBeenCalledWith(
        "/api/oidc/proxy/v1/videos",
        { model: "seedance-2.0", prompt: "测试视频", duration: 6, aspect_ratio: "1:1", resolution: "720p", generate_audio: true, first_image_url: image.url },
        { headers: { Authorization: "Bearer ", "Content-Type": "application/json" }, signal: undefined },
    );
});

it("uses Cangyuan multi-image and frame fields for Sub2API Seedance", async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: { id: "video-task" } });
    const image = { id: "image-1", name: "first.png", type: "image/png", url: "https://assets.example.com/first.png", dataUrl: "" };
    const secondImage = { ...image, id: "image-2", url: "https://assets.example.com/last.png" };

    await createVideoGenerationTask(sub2ApiSeedanceConfig, "首尾帧", [image, secondImage]);
    expect(vi.mocked(axios.post).mock.lastCall?.[1]).toMatchObject({ first_image_url: image.url, last_image_url: secondImage.url });

    await createVideoGenerationTask({ ...sub2ApiSeedanceConfig, videoMode: "reference" }, "多图参考", [image, secondImage]);
    expect(vi.mocked(axios.post).mock.lastCall?.[1]).toMatchObject({ reference_image_urls: [image.url, secondImage.url] });
});

it("omits auto aspect ratio and keeps the gateway task id for Sub2API Seedance", async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: { id: "video_gateway", task_id: "cangyuan-task" } });

    await expect(createVideoGenerationTask({ ...sub2ApiSeedanceConfig, size: "auto" }, "文生视频")).resolves.toEqual({ id: "video_gateway", provider: "openai", model: "oidc::seedance-2.0", adapter: "sub2api" });
    expect(vi.mocked(axios.post).mock.lastCall?.[1]).toEqual({ model: "seedance-2.0", prompt: "文生视频", duration: 6, resolution: "720p", generate_audio: true });
});

it("rejects a Sub2API Seedance response without a gateway task id", async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: { task_id: "cangyuan-task" } });

    await expect(createVideoGenerationTask(sub2ApiSeedanceConfig, "文生视频")).rejects.toThrow("视频接口没有返回任务 ID");
});

it("sends public HTTPS media references for Sub2API Seedance", async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: { id: "video-task" } });

    await createVideoGenerationTask(sub2ApiSeedanceConfig, "参考素材", [], {
        videos: [{ id: "v1", name: "clip.mp4", type: "video/mp4", url: "https://assets.example.com/clip.mp4" }],
        audios: [{ id: "a1", name: "ambient.mp3", type: "audio/mpeg", url: "https://assets.example.com/ambient.mp3" }],
    });
    expect(vi.mocked(axios.post).mock.lastCall?.[1]).toMatchObject({
        reference_videos: ["https://assets.example.com/clip.mp4"],
        reference_audios: ["https://assets.example.com/ambient.mp3"],
    });
});

it("uploads local Seedance reference media through the gateway Files API", async () => {
    vi.mocked(axios.post)
        .mockResolvedValueOnce({ data: { id: "file-video" } })
        .mockResolvedValueOnce({ data: { id: "file-audio" } })
        .mockResolvedValueOnce({ data: { id: "video-task" } });

    await createVideoGenerationTask(sub2ApiSeedanceConfig, "本地素材", [], {
        videos: [{ id: "v1", name: "clip.mp4", type: "video/mp4", storageKey: "video:local", url: "blob:https://localhost/clip" }],
        audios: [{ id: "a1", name: "ambient.mp3", type: "audio/mpeg", storageKey: "audio:local", url: "blob:https://localhost/audio" }],
    });

    expect(vi.mocked(axios.post)).toHaveBeenNthCalledWith(1, "/api/oidc/proxy/v1/files", expect.any(FormData), { headers: { Authorization: "Bearer " }, signal: undefined });
    expect(vi.mocked(axios.post)).toHaveBeenNthCalledWith(2, "/api/oidc/proxy/v1/files", expect.any(FormData), { headers: { Authorization: "Bearer " }, signal: undefined });
    expect(vi.mocked(axios.post).mock.lastCall?.[1]).toMatchObject({ reference_videos: [{ file_id: "file-video" }], reference_audios: [{ file_id: "file-audio" }] });
});

it("uses every image for generic xAI multi-image reference mode", async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: { request_id: "video-request" } });
    const image = { id: "image-1", name: "ref.png", type: "image/png", dataUrl: "data:image/png;base64,AA==" };

    await expect(createVideoGenerationTask({ ...genericXaiConfig, videoMode: "reference" }, "测试视频", [image, { ...image, id: "image-2" }])).resolves.toEqual({ id: "video-request", provider: "xai", model: "oidc::grok-imagine-video" });

    const payload = vi.mocked(axios.post).mock.lastCall?.[1];
    expect(payload).toMatchObject({ images: [{ url: image.dataUrl }, { url: image.dataUrl }] });
    expect(payload).not.toHaveProperty("reference_images");
});

it("uses only the first image for generic xAI first-frame mode", async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: { request_id: "video-request" } });
    const image = { id: "image-1", name: "first.png", type: "image/png", dataUrl: "data:image/png;base64,AA==" };
    const secondImage = { ...image, id: "image-2", dataUrl: "data:image/png;base64,BB==" };

    await createVideoGenerationTask(genericXaiConfig, "测试视频", [image, secondImage]);

    const payload = vi.mocked(axios.post).mock.lastCall?.[1];
    expect(payload).toMatchObject({ image: { url: image.dataUrl } });
    expect(payload).not.toHaveProperty("images");
});

it("downloads a completed Sub2API OpenAI video from its signed URL without gateway credentials", async () => {
    const content = new Blob(["video"], { type: "video/mp4" });
    vi.mocked(axios.get)
        .mockResolvedValueOnce({ data: { status: "completed", video: { url: "https://storage.example/video.mp4" } } })
        .mockResolvedValueOnce({ data: content });

    await expect(pollVideoGenerationTask(sub2ApiOpenAiConfig, { id: "video-task", provider: "openai", model: "oidc::video-model", adapter: "sub2api" }))
        .resolves.toEqual({ status: "completed", result: { blob: content } });
    expect(axios.get).toHaveBeenNthCalledWith(1, "/api/oidc/proxy/v1/videos/video-task", { headers: { Authorization: "Bearer " }, signal: undefined });
    expect(axios.get).toHaveBeenNthCalledWith(2, "https://storage.example/video.mp4", { responseType: "blob", signal: undefined });
});

it("downloads a completed Sub2API Seedance video from data[0].url", async () => {
    const content = new Blob(["video"], { type: "video/mp4" });
    vi.mocked(axios.get)
        .mockResolvedValueOnce({ data: { id: "video-task", status: "completed", data: [{ url: "https://storage.example/video.mp4" }] } })
        .mockResolvedValueOnce({ data: content });

    await expect(pollVideoGenerationTask(sub2ApiSeedanceConfig, { id: "video-task", provider: "openai", model: "oidc::seedance-2.0", adapter: "sub2api" }))
        .resolves.toEqual({ status: "completed", result: { blob: content } });
    expect(axios.get).toHaveBeenNthCalledWith(2, "https://storage.example/video.mp4", { responseType: "blob", signal: undefined });
});

it("falls back to the Sub2API content endpoint when a completed video has no signed URL", async () => {
    const content = new Blob(["video"], { type: "video/mp4" });
    vi.mocked(axios.get)
        .mockResolvedValueOnce({ data: { status: "completed" } })
        .mockResolvedValueOnce({ data: content });

    await expect(pollVideoGenerationTask(sub2ApiOpenAiConfig, { id: "video-task", provider: "openai", model: "oidc::video-model", adapter: "sub2api" }))
        .resolves.toEqual({ status: "completed", result: { blob: content } });
    expect(axios.get).toHaveBeenNthCalledWith(2, "/api/oidc/proxy/v1/videos/video-task/content", { headers: { Authorization: "Bearer " }, responseType: "blob", signal: undefined });
});

it("falls back to the Sub2API content endpoint when the signed download is an error Blob", async () => {
    const content = new Blob(["video"], { type: "video/mp4" });
    vi.mocked(axios.get)
        .mockResolvedValueOnce({ data: { status: "completed", video: { url: "https://storage.example/video.mp4" } } })
        .mockResolvedValueOnce({ data: new Blob(["{\"error\":\"expired\"}"], { type: "application/json" }) })
        .mockResolvedValueOnce({ data: content });

    await expect(pollVideoGenerationTask(sub2ApiOpenAiConfig, { id: "video-task", provider: "openai", model: "oidc::video-model", adapter: "sub2api" }))
        .resolves.toEqual({ status: "completed", result: { blob: content } });
    expect(axios.get).toHaveBeenNthCalledWith(3, "/api/oidc/proxy/v1/videos/video-task/content", { headers: { Authorization: "Bearer " }, responseType: "blob", signal: undefined });
});

it("falls back to the Sub2API content endpoint when the signed error Blob has no MIME type", async () => {
    const content = new Blob(["video"], { type: "video/mp4" });
    vi.mocked(axios.get)
        .mockResolvedValueOnce({ data: { status: "completed", video: { url: "https://storage.example/video.mp4" } } })
        .mockResolvedValueOnce({ data: new Blob(["{\"error\":\"expired\"}"]) })
        .mockResolvedValueOnce({ data: content });

    await expect(pollVideoGenerationTask(sub2ApiOpenAiConfig, { id: "video-task", provider: "openai", model: "oidc::video-model", adapter: "sub2api" }))
        .resolves.toEqual({ status: "completed", result: { blob: content } });
    expect(axios.get).toHaveBeenNthCalledWith(3, "/api/oidc/proxy/v1/videos/video-task/content", { headers: { Authorization: "Bearer " }, responseType: "blob", signal: undefined });
});

it("falls back to the Sub2API content endpoint when the signed download rejects", async () => {
    const content = new Blob(["video"], { type: "video/mp4" });
    vi.mocked(axios.get)
        .mockResolvedValueOnce({ data: { status: "completed", video: { url: "https://storage.example/video.mp4" } } })
        .mockRejectedValueOnce(new Error("signed URL expired"))
        .mockResolvedValueOnce({ data: content });

    await expect(pollVideoGenerationTask(sub2ApiOpenAiConfig, { id: "video-task", provider: "openai", model: "oidc::video-model", adapter: "sub2api" }))
        .resolves.toEqual({ status: "completed", result: { blob: content } });
    expect(axios.get).toHaveBeenNthCalledWith(3, "/api/oidc/proxy/v1/videos/video-task/content", { headers: { Authorization: "Bearer " }, responseType: "blob", signal: undefined });
});

it("rejects an invalid Sub2API content Blob", async () => {
    vi.mocked(axios.get)
        .mockResolvedValueOnce({ data: { status: "completed" } })
        .mockResolvedValueOnce({ data: new Blob(["<html>access denied</html>"], { type: "text/html" }) });

    await expect(pollVideoGenerationTask(sub2ApiOpenAiConfig, { id: "video-task", provider: "openai", model: "oidc::video-model", adapter: "sub2api" }))
        .rejects.toThrow("视频下载失败");
});

it("rejects an octet-stream Sub2API content error Blob", async () => {
    vi.mocked(axios.get)
        .mockResolvedValueOnce({ data: { status: "completed" } })
        .mockResolvedValueOnce({ data: new Blob(["{\"error\":\"access denied\"}"], { type: "application/octet-stream" }) });

    await expect(pollVideoGenerationTask(sub2ApiOpenAiConfig, { id: "video-task", provider: "openai", model: "oidc::video-model", adapter: "sub2api" }))
        .rejects.toThrow("视频下载失败");
});

it("accepts an octet-stream MP4 container from a Sub2API signed URL", async () => {
    const content = new Blob([new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])], { type: "application/octet-stream" });
    vi.mocked(axios.get)
        .mockResolvedValueOnce({ data: { status: "completed", video: { url: "https://storage.example/video.mp4" } } })
        .mockResolvedValueOnce({ data: content });

    await expect(pollVideoGenerationTask(sub2ApiOpenAiConfig, { id: "video-task", provider: "openai", model: "oidc::video-model", adapter: "sub2api" }))
        .resolves.toEqual({ status: "completed", result: { blob: content } });
    expect(axios.get).toHaveBeenCalledTimes(2);
});

it("keeps Sub2API OpenAI queued and in-progress tasks pending, and preserves failures", async () => {
    const task = { id: "video-task", provider: "openai" as const, model: "oidc::video-model", adapter: "sub2api" as const };
    vi.mocked(axios.get)
        .mockResolvedValueOnce({ data: { status: "queued" } })
        .mockResolvedValueOnce({ data: { status: "in_progress" } })
        .mockResolvedValueOnce({ data: { status: "failed", error: { message: "上游拒绝任务" } } });

    await expect(pollVideoGenerationTask(sub2ApiOpenAiConfig, task)).resolves.toEqual({ status: "pending" });
    await expect(pollVideoGenerationTask(sub2ApiOpenAiConfig, task)).resolves.toEqual({ status: "pending" });
    await expect(pollVideoGenerationTask(sub2ApiOpenAiConfig, task)).resolves.toEqual({ status: "failed", error: "上游拒绝任务" });
});

it("maps Sub2API xAI done, failed, and expired states", async () => {
    const content = new Blob(["video"], { type: "video/mp4" });
    const task = { id: "video-request", provider: "xai" as const, model: "oidc::grok-imagine-video", adapter: "sub2api" as const };
    vi.mocked(axios.get)
        .mockResolvedValueOnce({ data: { status: "done", video: { url: "https://storage.example/video.mp4" } } })
        .mockResolvedValueOnce({ data: content })
        .mockResolvedValueOnce({ data: { status: "failed", error: { message: "生成失败" } } })
        .mockResolvedValueOnce({ data: { status: "expired", error: { message: "任务已过期" } } });

    await expect(pollVideoGenerationTask(oidcXaiConfig, task)).resolves.toEqual({ status: "completed", result: { blob: content } });
    await expect(pollVideoGenerationTask(oidcXaiConfig, task)).resolves.toEqual({ status: "failed", error: "生成失败" });
    await expect(pollVideoGenerationTask(oidcXaiConfig, task)).resolves.toEqual({ status: "failed", error: "任务已过期" });
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
