import axios from "axios";

import i18n from "@/i18n";
import { dataUrlToFile } from "@/lib/image-utils";
import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob, imageToDataUrl } from "@/services/image-storage";
import { boolConfig, buildApiUrl, modelOptionName, type ModelRequestConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import type { VideoGenerationTask, VideoGenerationTaskState } from "./video";

type RequestOptions = { signal?: AbortSignal; videos?: ReferenceVideo[]; audios?: ReferenceAudio[] };
type OpenAIVideoTask = { id?: string; status?: string; video?: { url?: string } | null; data?: Array<{ url?: string }> | { url?: string } | null; error?: { message?: string } | string | null };
type XaiVideoTask = { request_id?: string; status?: "pending" | "done" | "failed" | "expired"; video?: { url?: string } | null; error?: { message?: string } | string | null };
type ApiVideoResponse = OpenAIVideoTask | { code?: number | string; data?: OpenAIVideoTask | null; msg?: string; message?: string; error?: { message?: string } };
type GatewayFileResponse = { id?: string; data?: { id?: string } | null; error?: { message?: string } | string; message?: string };
type CangyuanMediaReference = string | { file_id: string };
const SEEDANCE_MODELS = new Set(["seedance-2.0", "seedance-2.0-mini", "seedance-2.0-fast"]);
const apiText = (key: string) => i18n.t(`apiErrors.${key}`);
const forkVideoText = (key: string) => i18n.t(`fork.video.${key}`);

export function isSeedanceModel(model: string) {
    return SEEDANCE_MODELS.has(modelOptionName(model).toLowerCase());
}

export async function createSub2ApiVideoTask(config: ModelRequestConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    return config.apiFormat === "xai"
        ? createSub2ApiXaiVideoTask(config, model, prompt, references, options)
        : isSeedanceModel(model)
            ? createSub2ApiSeedanceVideoTask(config, model, prompt, references, options)
            : createSub2ApiOpenAIVideoTask(config, model, prompt, references, options);
}

export async function pollSub2ApiVideoTask(config: ModelRequestConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    return task.provider === "xai"
        ? pollSub2ApiXaiVideoTask(config, task, options)
        : pollSub2ApiOpenAIVideoTask(config, task, options);
}

async function createSub2ApiSeedanceVideoTask(config: ModelRequestConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    try {
        const imageUrls = await Promise.all(references.map((image) => uploadImageReference(config, image, options)));
        const mode = resolveCangyuanVideoMode(config.videoMode, imageUrls.length);
        const payload: Record<string, unknown> = {
            model: modelOptionName(model),
            prompt,
            duration: normalizeCangyuanSeconds(config.videoSeconds),
            resolution: normalizeResolution(config.vquality),
            generate_audio: boolConfig(config.videoGenerateAudio, true),
        };
        const aspectRatio = normalizeAspectRatio(config.size);
        if (aspectRatio) payload.aspect_ratio = aspectRatio;
        if (mode === "frames") {
            if (imageUrls[0]) payload.first_image_url = imageUrls[0];
            if (imageUrls[1]) payload.last_image_url = imageUrls[1];
        } else if (imageUrls.length) {
            payload.reference_image_urls = imageUrls;
        }
        const videoUrls = await uploadMediaReferences(config, options?.videos, options);
        const audioUrls = await uploadMediaReferences(config, options?.audios, options);
        if (videoUrls.length) payload.reference_videos = videoUrls;
        if (audioUrls.length) payload.reference_audios = audioUrls;
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(apiUrl(config, "/videos"), payload, requestOptions(config, "application/json", options))).data);
        if (!created.id) throw new Error(apiText("noVideoTaskId"));
        return { id: created.id, provider: "openai", model, adapter: "sub2api" };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

async function createSub2ApiOpenAIVideoTask(config: ModelRequestConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    try {
        const imageUrls = await Promise.all(references.map((image) => imageToDataUrl(image)));
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(apiUrl(config, "/videos"), {
            model: modelOptionName(model),
            prompt,
            seconds: normalizeOpenAiSeconds(config.videoSeconds),
            size: normalizeVideoSize(config.size),
            preset: "normal",
            ...(imageUrls.length ? { input_reference: imageUrls.map((image_url) => ({ type: "image", image_url })) } : {}),
        }, requestOptions(config, "application/json", options))).data);
        if (!created.id) throw new Error(apiText("noVideoTaskId"));
        return { id: created.id, provider: "openai", model, adapter: "sub2api" };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

async function createSub2ApiXaiVideoTask(config: ModelRequestConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    try {
        const selected = config.videoMode === "reference" ? references : references.slice(0, 1);
        const imageUrls = await Promise.all(selected.map((image) => imageToDataUrl(image)));
        const size = normalizeVideoSize(config.size);
        const [width, height] = size.split("x");
        const created = (await axios.post<XaiVideoTask>(apiUrl(config, "/videos/generations"), {
            model: modelOptionName(model),
            prompt,
            duration: normalizeXaiSeconds(config.videoSeconds),
            aspect_ratio: reduceAspectRatio(Number(width), Number(height)),
            resolution: normalizeResolution(config.vquality),
            preset: "normal",
            ...(imageUrls.length === 1 ? { image: { url: imageUrls[0] } } : imageUrls.length > 1 ? { reference_images: imageUrls.map((url) => ({ url })) } : {}),
        }, requestOptions(config, "application/json", options))).data;
        if (!created.request_id) throw new Error(forkVideoText("xaiNoTaskId"));
        return { id: created.request_id, provider: "xai", model, adapter: "sub2api" };
    } catch (error) {
        throw new Error(readAxiosError(error, forkVideoText("xaiTaskCreateFailed")));
    }
}

async function pollSub2ApiOpenAIVideoTask(config: ModelRequestConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const video = unwrapVideoResponse((await axios.get<ApiVideoResponse>(apiUrl(config, `/videos/${task.id}`), requestOptions(config, undefined, options))).data);
        const status = String(video.status || "").toLowerCase();
        const resultUrl = video.video?.url || (Array.isArray(video.data) ? video.data[0]?.url : video.data?.url);
        if (["completed", "complete", "succeeded", "success", "done"].includes(status) || (!status && resultUrl)) return { status: "completed", result: { blob: await downloadVideoBlob(config, task, resultUrl, options) } };
        if (["failed", "error", "cancelled", "canceled"].includes(status)) return { status: "failed", error: readError(video.error) || apiText("videoGenerationFailed") };
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskQueryFailed")));
    }
}

async function pollSub2ApiXaiVideoTask(config: ModelRequestConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const state = (await axios.get<XaiVideoTask>(apiUrl(config, `/videos/${task.id}`), requestOptions(config, undefined, options))).data;
        if (state.status === "done") return { status: "completed", result: { blob: await downloadVideoBlob(config, task, state.video?.url, options) } };
        if (state.status === "failed" || state.status === "expired") return { status: "failed", error: readError(state.error) || forkVideoText(state.status === "expired" ? "xaiGenerationExpired" : "xaiGenerationFailed") };
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, forkVideoText("xaiTaskQueryFailed")));
    }
}

async function downloadVideoBlob(config: ModelRequestConfig, task: VideoGenerationTask, signedUrl: string | undefined, options?: RequestOptions) {
    if (signedUrl) {
        try {
            const response = await axios.get<Blob>(signedUrl, { responseType: "blob", signal: options?.signal });
            if (await isVideoBlob(response.data)) return response.data;
        } catch (error) {
            if (axios.isCancel(error) || options?.signal?.aborted) throw error;
        }
    }
    const response = await axios.get<Blob>(apiUrl(config, `/videos/${task.id}/content`), { ...requestOptions(config, undefined, options), responseType: "blob" });
    if (!(await isVideoBlob(response.data))) throw new Error(apiText("videoDownloadFailed"));
    return response.data;
}

async function isVideoBlob(value: unknown): Promise<boolean> {
    if (!(value instanceof Blob) || value.size === 0) return false;
    const mimeType = value.type.split(";", 1)[0].trim().toLowerCase();
    if (mimeType.startsWith("video/")) return true;
    if (mimeType && mimeType !== "application/octet-stream") return false;
    const bytes = new Uint8Array(await value.slice(0, 12).arrayBuffer());
    return (bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70)
        || (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3);
}

function apiUrl(config: ModelRequestConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

function requestOptions(config: ModelRequestConfig, contentType: string | undefined, options?: RequestOptions) {
    return { headers: { Authorization: `Bearer ${config.apiKey}`, ...(contentType ? { "Content-Type": contentType } : {}) }, signal: options?.signal };
}

async function uploadImageReference(config: ModelRequestConfig, image: ReferenceImage, options?: RequestOptions): Promise<CangyuanMediaReference> {
    if (isHttpsUrl(image.url)) return image.url;
    const blob = image.storageKey ? await getImageBlob(image.storageKey) : image.dataUrl?.startsWith("data:") ? dataUrlToFile(image) : undefined;
    if (!blob) throw new Error(apiText("referenceImageReadFailed"));
    return { file_id: await uploadGatewayFile(config, blob, image.name || "reference-image", options) };
}

async function uploadMediaReferences(config: ModelRequestConfig, items: Array<{ url?: string; storageKey?: string; name?: string }> | undefined, options?: RequestOptions): Promise<CangyuanMediaReference[]> {
    return Promise.all((items || []).map(async (item) => {
        if (isHttpsUrl(item.url)) return item.url;
        if (!item.storageKey) throw new Error(apiText("localAssetReadFailed"));
        const blob = await getMediaBlob(item.storageKey);
        if (!blob) throw new Error(apiText("localAssetReadFailed"));
        return { file_id: await uploadGatewayFile(config, blob, item.name || "reference-media", options) };
    }));
}

async function uploadGatewayFile(config: ModelRequestConfig, blob: Blob, filename: string, options?: RequestOptions) {
    const form = new FormData();
    form.append("purpose", "user_data");
    form.append("file", blob, filename);
    const response = await axios.post<GatewayFileResponse>(apiUrl(config, "/files"), form, requestOptions(config, undefined, options));
    const fileId = response.data.id || response.data.data?.id;
    if (!fileId) throw new Error(readError(response.data) || apiText("videoTaskCreateFailed"));
    return fileId;
}

function normalizeCangyuanSeconds(value: string) {
    return Math.max(1, Math.min(30, Math.floor(Number(value) || 6)));
}

function normalizeOpenAiSeconds(value: string) {
    return String(Math.max(1, Math.min(20, Math.floor(Number(value) || 6))));
}

function normalizeXaiSeconds(value: string) {
    return Math.max(1, Math.min(15, Math.floor(Number(value) || 6)));
}

function normalizeAspectRatio(value: string) {
    if (!value || value === "auto") return undefined;
    if (/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(value)) return value;
    if (/^(\d+)x(\d+)$/.test(value)) {
        const [, width, height] = value.match(/^(\d+)x(\d+)$/) || [];
        return reduceAspectRatio(Number(width), Number(height));
    }
    return undefined;
}

function normalizeVideoSize(value: string) {
    if (/^\d+x\d+$/.test(value || "")) return value;
    return ["9:16", "2:3", "3:4"].includes(value) ? "720x1280" : "1280x720";
}

function normalizeResolution(value: string) {
    if (value === "low") return "480p";
    if (value === "auto" || value === "high" || value === "medium") return "720p";
    return `${value.replace(/p$/i, "") || "720"}p`;
}

function reduceAspectRatio(width: number, height: number) {
    const divisor = gcd(width, height);
    return `${width / divisor}:${height / divisor}`;
}

function gcd(left: number, right: number): number {
    return right ? gcd(right, left % right) : left;
}

function unwrapVideoResponse(payload: ApiVideoResponse): OpenAIVideoTask {
    if ("code" in payload && payload.code !== undefined) {
        if (payload.code !== 0 && payload.code !== "0") throw new Error(readError(payload) || apiText("requestFailed"));
        if (!payload.data) throw new Error(apiText("noVideoTask"));
        return payload.data;
    }
    return payload;
}

function resolveCangyuanVideoMode(mode: string | undefined, imageCount: number) {
    if (mode === "reference" || imageCount > 2) return "reference";
    return "frames";
}

function isHttpsUrl(value: string | undefined): value is string {
    return typeof value === "string" && /^https:\/\//i.test(value);
}

function readError(value: unknown): string {
    if (!value) return "";
    if (typeof value === "string") {
        try {
            return readError(JSON.parse(value)) || value;
        } catch {
            return value;
        }
    }
    if (typeof value !== "object") return "";
    const payload = value as { msg?: unknown; message?: unknown; error?: unknown };
    return readError(payload.msg) || readError(payload.message) || readError(payload.error) || "";
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return apiText("requestCanceled");
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; message?: string }>(error)) {
        return readError(error.response?.data) || fallback;
    }
    if (error instanceof DOMException && error.name === "AbortError") return apiText("requestCanceled");
    return error instanceof Error ? readError(error.message) || error.message : fallback;
}
