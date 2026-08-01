import axios from "axios";

import { buildApiUrl, modelOptionName, type ModelRequestConfig } from "@/stores/use-config-store";
import { imageToDataUrl } from "@/services/image-storage";
import type { ReferenceImage } from "@/types/image";
import type { VideoGenerationTask } from "./video";

type RequestOptions = { signal?: AbortSignal };
type VideoResponse = { id: string };
type XaiVideoTask = { request_id?: string };
type ApiVideoResponse = VideoResponse | { code?: number | string; data?: VideoResponse | null; msg?: string; message?: string; error?: { message?: string } };

export async function createSub2ApiVideoTask(config: ModelRequestConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    return config.apiFormat === "xai"
        ? createSub2ApiXaiVideoTask(config, model, prompt, references, options)
        : createSub2ApiOpenAIVideoTask(config, model, prompt, references, options);
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
        if (!created.id) throw new Error("视频接口没有返回任务 ID");
        return { id: created.id, provider: "openai", model, adapter: "sub2api" };
    } catch (error) {
        throw new Error(readAxiosError(error, "视频任务创建失败"));
    }
}

async function createSub2ApiXaiVideoTask(config: ModelRequestConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    try {
        const imageUrls = await Promise.all(references.map((image) => imageToDataUrl(image)));
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
        if (!created.request_id) throw new Error("xAI 视频接口没有返回任务 ID");
        return { id: created.request_id, provider: "xai", model, adapter: "sub2api" };
    } catch (error) {
        throw new Error(readAxiosError(error, "xAI 视频任务创建失败"));
    }
}

function apiUrl(config: ModelRequestConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

function requestOptions(config: ModelRequestConfig, contentType: string | undefined, options?: RequestOptions) {
    return { headers: { Authorization: `Bearer ${config.apiKey}`, ...(contentType ? { "Content-Type": contentType } : {}) }, signal: options?.signal };
}

function normalizeOpenAiSeconds(value: string) {
    return String(Math.max(1, Math.min(20, Math.floor(Number(value) || 6))));
}

function normalizeXaiSeconds(value: string) {
    return Math.max(1, Math.min(15, Math.floor(Number(value) || 6)));
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

function unwrapVideoResponse(payload: ApiVideoResponse): VideoResponse {
    if ("code" in payload && payload.code !== undefined) {
        if (payload.code !== 0 && payload.code !== "0") throw new Error(readError(payload) || "请求失败");
        if (!payload.data) throw new Error("接口没有返回视频任务");
        return payload.data;
    }
    return payload;
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
    if (axios.isCancel(error)) return "请求已取消";
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; message?: string }>(error)) {
        return readError(error.response?.data) || fallback;
    }
    if (error instanceof DOMException && error.name === "AbortError") return "请求已取消";
    return error instanceof Error ? readError(error.message) || error.message : fallback;
}
