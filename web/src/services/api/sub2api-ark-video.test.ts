import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { getImageBlob, getMediaBlob } = vi.hoisted(() => ({
    getImageBlob: vi.fn(async () => new Blob(["image"], { type: "image/png" })),
    getMediaBlob: vi.fn(async () => new Blob(["media"], { type: "video/mp4" })),
}));
vi.mock("axios", () => ({ default: { post: vi.fn(), get: vi.fn(), isCancel: vi.fn(() => false), isAxiosError: vi.fn((error) => Boolean(error?.isAxiosError)) } }));
vi.mock("@/services/image-storage", () => ({ getImageBlob, imageToDataUrl: vi.fn() }));
vi.mock("@/services/file-storage", () => ({ getMediaBlob }));

import axios from "axios";
import { defaultConfig, type ModelRequestConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { VideoGenerationTask } from "./video";
import { createSub2ApiVideoTask, pollSub2ApiVideoTask } from "./sub2api-video";
import { clearSub2ApiMediaCache, uploadImageReference } from "./sub2api-media";

const taskId = "video_11111111-1111-4111-8111-111111111111";
const model = "sub2api::seedance-2.5";
const task: VideoGenerationTask = { id: taskId, model, provider: "ark", adapter: "sub2api" };
const endpoint = "https://gateway.example/api/v3/contents/generations/tasks";
const image: ReferenceImage = { id: "image", name: "first.png", type: "image/png", dataUrl: "", url: "https://media.example/first.png" };
let config: ModelRequestConfig;
let serial = 0;

beforeEach(() => {
    vi.clearAllMocks();
    clearSub2ApiMediaCache();
    config = { ...defaultConfig, providerId: "sub2api", authMode: "manual", apiFormat: "ark", baseUrl: "https://gateway.example", apiKey: `test-${serial++}`, model: "seedance-2.5", videoMode: "reference", videoSeconds: "6", vquality: "720", size: "1280x720" };
});
afterEach(() => vi.useRealTimers());

function accepted() {
    return { data: { id: taskId, status: "queued" } };
}
function httpError(status?: number, data?: unknown, headers = {}) {
    return Object.assign(new Error("request failed"), { isAxiosError: true, ...(status ? { response: { status, data, headers } } : {}) });
}

it("creates Ark JSON with the public model and shared fields, omitting auto ratio and unsupported flags", async () => {
    vi.mocked(axios.post).mockResolvedValueOnce(accepted());
    await expect(createSub2ApiVideoTask({ ...config, size: "auto", videoWatermark: "true" }, model, "海浪", [])).resolves.toEqual(task);
    expect(axios.post).toHaveBeenCalledExactlyOnceWith(endpoint, {
        model: "seedance-2.5", content: [{ type: "text", text: "海浪" }], duration: 6, resolution: "720p", generate_audio: true,
    }, { headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" }, signal: undefined });
});

it("supports OIDC without a browser API key or a duplicate v1 path", async () => {
    vi.mocked(axios.post).mockResolvedValueOnce(accepted());
    await createSub2ApiVideoTask({ ...config, baseUrl: "/api/oidc/proxy", authMode: "oidc", apiKey: "" }, model, "海浪", []);
    expect(axios.post).toHaveBeenCalledWith("/api/oidc/proxy/api/v3/contents/generations/tasks", expect.any(Object), { headers: { "Content-Type": "application/json" }, signal: undefined });
});

it("preserves first and last frame order and sends HTTPS references without uploading", async () => {
    vi.mocked(axios.post).mockResolvedValueOnce(accepted());
    await createSub2ApiVideoTask({ ...config, videoMode: "frames" }, model, "首尾帧", [image, { ...image, url: "https://media.example/last.png" }]);
    expect(vi.mocked(axios.post).mock.calls[0][1]).toMatchObject({
        ratio: "16:9", content: [
            { type: "text", text: "首尾帧" },
            { type: "image_url", role: "first_frame", image_url: { url: image.url } },
            { type: "image_url", role: "last_frame", image_url: { url: "https://media.example/last.png" } },
        ],
    });
    expect(axios.post).toHaveBeenCalledTimes(1);
});

it("uploads local images, videos and audio to the Ark family and uses nested file IDs", async () => {
    vi.mocked(axios.post).mockImplementation(async (url, body) => {
        if (String(url).endsWith("/files")) return { data: { id: `file-${(body as FormData).get("file") instanceof File ? ((body as FormData).get("file") as File).name : "missing"}`, expires_at: Math.floor(Date.now() / 1000) + 3600 } };
        return accepted();
    });
    await createSub2ApiVideoTask(config, model, "多模态", [{ ...image, url: undefined, storageKey: "image:local" }], {
        videos: [{ id: "v", name: "clip.mp4", type: "video/mp4", storageKey: "video:local", url: "blob:video" }],
        audios: [{ id: "a", name: "audio.mp3", type: "audio/mpeg", storageKey: "audio:local", url: "blob:audio" }],
    });
    const uploads = vi.mocked(axios.post).mock.calls.filter(([url]) => String(url).endsWith("/files"));
    expect(uploads).toHaveLength(3);
    for (const [, body, options] of uploads) {
        expect((body as FormData).get("purpose")).toBe("user_data");
        expect(options?.headers).toEqual({ Authorization: `Bearer ${config.apiKey}`, "X-Video-Protocol": "ark" });
    }
    expect(vi.mocked(axios.post).mock.lastCall?.[1]).toMatchObject({ content: [
        { type: "text", text: "多模态" },
        { type: "image_url", role: "reference_image", image_url: { file_id: "file-first.png" } },
        { type: "video_url", role: "reference_video", video_url: { file_id: "file-clip.mp4" } },
        { type: "audio_url", role: "reference_audio", audio_url: { file_id: "file-audio.mp3" } },
    ] });
});

it("rejects incompatible frame references and excess inputs before any upload", async () => {
    const videos = [{ id: "v", name: "clip.mp4", type: "video/mp4", storageKey: "video:local", url: "blob:video" }];
    await expect(createSub2ApiVideoTask({ ...config, videoMode: "frames" }, model, "冲突", [image], { videos })).rejects.toThrow();
    await expect(createSub2ApiVideoTask({ ...config, videoMode: "frames" }, model, "超量", [image, image, image])).rejects.toThrow();
    await expect(createSub2ApiVideoTask(config, model, "超量", Array(10).fill(image))).rejects.toThrow();
    await expect(createSub2ApiVideoTask(config, model, "超量", [], { videos: Array(4).fill(videos[0]) })).rejects.toThrow();
    expect(axios.post).not.toHaveBeenCalled();
});

it("reuses ready files until expiry and isolates Ark files from Cangyuan", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    let uploads = 0;
    vi.mocked(axios.post).mockImplementation(async (url) => String(url).endsWith("/files") ? { data: { id: `file-${++uploads}`, expires_at: Math.floor(start / 1000) + 120 } } : accepted());
    const local = { ...image, url: undefined, storageKey: "image:expiry" };
    await createSub2ApiVideoTask(config, model, "首次", [local]);
    await createSub2ApiVideoTask(config, model, "复用", [local]);
    expect(uploads).toBe(1);
    await createSub2ApiVideoTask({ ...config, apiFormat: "openai" }, model, "不同协议", [local]);
    expect(uploads).toBe(2);
    vi.setSystemTime(start + 121_000);
    await createSub2ApiVideoTask(config, model, "过期", [local]);
    expect(uploads).toBe(3);
});

it("deduplicates simultaneous uploads but does not restore a cleared session cache", async () => {
    let finish!: (value: { data: { id: string } }) => void;
    vi.mocked(axios.post).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValueOnce({ data: { id: "file-new-session" } });
    const local = { ...image, url: undefined, storageKey: "image:session" };
    const first = uploadImageReference(config, local);
    const duplicate = uploadImageReference(config, local);
    await vi.waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1));
    clearSub2ApiMediaCache();
    finish({ data: { id: "file-old-session" } });
    await expect(first).resolves.toEqual({ file_id: "file-old-session" });
    await expect(duplicate).resolves.toEqual({ file_id: "file-old-session" });
    await expect(uploadImageReference(config, local)).resolves.toEqual({ file_id: "file-new-session" });
    expect(axios.post).toHaveBeenCalledTimes(2);
});

it("preserves file-upload authorization errors without retrying or creating a task", async () => {
    vi.mocked(axios.post).mockRejectedValueOnce(httpError(401, { error: { message: "文件上传未授权" } }));
    await expect(createSub2ApiVideoTask(config, model, "本地图片", [{ ...image, url: undefined, storageKey: "image:denied" }])).rejects.toThrow("文件上传未授权");
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(vi.mocked(axios.post).mock.calls[0][0]).toBe("https://gateway.example/v1/files");
});

it.each([undefined, 408, 503])("never automatically repeats an uncertain creation (%s)", async (status) => {
    vi.mocked(axios.post).mockRejectedValueOnce(httpError(status));
    await expect(createSub2ApiVideoTask(config, model, "海浪", [])).rejects.toThrow();
    expect(axios.post).toHaveBeenCalledTimes(1);
});

it.each([{ id: "native-id", status: "queued" }, { id: taskId, status: "completed" }, { status: "queued" }])("rejects invalid creation responses %j", async (data) => {
    vi.mocked(axios.post).mockResolvedValueOnce({ data });
    await expect(createSub2ApiVideoTask(config, model, "海浪", [])).rejects.toThrow();
    expect(axios.post).toHaveBeenCalledTimes(1);
});

it.each(["queued", "running"])("keeps %s pending on the saved Ark protocol", async (status) => {
    vi.mocked(axios.get).mockResolvedValueOnce({ data: { id: taskId, status } });
    await expect(pollSub2ApiVideoTask({ ...config, apiFormat: "openai" }, task)).resolves.toEqual({ status: "pending" });
    expect(axios.get).toHaveBeenCalledWith(`${endpoint}/${taskId}`, expect.any(Object));
});

it.each(["failed", "expired"])("stops on %s with the public error", async (status) => {
    vi.mocked(axios.get).mockResolvedValueOnce({ data: { id: taskId, status, error: { message: "生成不可用" } } });
    await expect(pollSub2ApiVideoTask(config, task)).resolves.toEqual({ status: "failed", error: "生成不可用" });
});

it("downloads an archived result without credentials or a content fallback", async () => {
    const blob = new Blob(["video"], { type: "video/mp4" });
    vi.mocked(axios.get).mockResolvedValueOnce({ data: { id: taskId, status: "succeeded", content: { video_url: "https://media.example/result" } } }).mockResolvedValueOnce({ data: blob });
    await expect(pollSub2ApiVideoTask(config, task)).resolves.toEqual({ status: "completed", result: { blob } });
    expect(axios.get).toHaveBeenLastCalledWith("https://media.example/result", { responseType: "blob", signal: undefined });
    expect(axios.get).toHaveBeenCalledTimes(2);
});

it("allows an expired signed download to requery the same task for a fresh URL", async () => {
    const blob = new Blob(["video"], { type: "video/mp4" });
    vi.mocked(axios.get)
        .mockResolvedValueOnce({ data: { id: taskId, status: "succeeded", content: { video_url: "https://media.example/expired" } } })
        .mockRejectedValueOnce(httpError(403))
        .mockResolvedValueOnce({ data: { id: taskId, status: "succeeded", content: { video_url: "https://media.example/fresh" } } })
        .mockResolvedValueOnce({ data: blob });
    await expect(pollSub2ApiVideoTask(config, task)).rejects.toMatchObject({ name: "VideoPollingRetryable" });
    await expect(pollSub2ApiVideoTask(config, task)).resolves.toEqual({ status: "completed", result: { blob } });
    expect(axios.post).not.toHaveBeenCalled();
    expect(vi.mocked(axios.get).mock.calls.map(([url]) => url)).toEqual([`${endpoint}/${taskId}`, "https://media.example/expired", `${endpoint}/${taskId}`, "https://media.example/fresh"]);
});

it.each(["completed", "cancelled", "unknown"])("rejects invalid new-task status %s", async (status) => {
    vi.mocked(axios.get).mockResolvedValueOnce({ data: { id: taskId, status } });
    await expect(pollSub2ApiVideoTask(config, task)).rejects.toThrow();
});

it("rejects a task identity mismatch", async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({ data: { id: "video_22222222-2222-4222-8222-222222222222", status: "running" } });
    await expect(pollSub2ApiVideoTask(config, task)).rejects.toThrow();
});

it.each([undefined, 408, 429, 502])("marks transient query errors (%s) for bounded backoff", async (status) => {
    vi.mocked(axios.get).mockRejectedValueOnce(httpError(status, undefined, { "retry-after": "120" }));
    await expect(pollSub2ApiVideoTask(config, task)).rejects.toMatchObject({ name: "VideoPollingRetryable", ...(status ? { retryAfterMs: 30_000 } : {}) });
});

it("pauses on the administrative polling code instead of retrying a generic 503", async () => {
    vi.mocked(axios.get).mockRejectedValueOnce(httpError(503, { error: { code: "video_polling_paused", message: "manual review" } }));
    await expect(pollSub2ApiVideoTask(config, task)).rejects.toMatchObject({ name: "VideoPollingPaused" });
    expect(axios.get).toHaveBeenCalledTimes(1);
});

it.each([401, 403, 404, 422])("does not retry permanent query errors (%s)", async (status) => {
    vi.mocked(axios.get).mockRejectedValueOnce(httpError(status, { error: { message: "无权访问" } }));
    await expect(pollSub2ApiVideoTask(config, task)).rejects.toMatchObject({ name: "Error", message: "无权访问" });
});
