import axios from "axios";

import i18n from "@/i18n";
import { dataUrlToFile } from "@/lib/image-utils";
import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob } from "@/services/image-storage";
import { buildApiUrl, type ModelRequestConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";

type RequestOptions = { signal?: AbortSignal };
type GatewayFile = { id: string; expires_at?: number | null };
type GatewayFileResponse = Partial<GatewayFile> & { data?: GatewayFile };
export type GatewayMediaReference = string | { file_id: string };
const gatewayFileCache = new Map<string, GatewayFile>();
const gatewayFileUploads = new Map<string, Promise<GatewayFile>>();
const apiText = (key: string) => i18n.t(`apiErrors.${key}`);

export function clearSub2ApiMediaCache() {
    gatewayFileCache.clear();
    gatewayFileUploads.clear();
}

export async function uploadImageReference(config: ModelRequestConfig, image: ReferenceImage, options?: RequestOptions): Promise<GatewayMediaReference> {
    if (isHttpsUrl(image.url)) return image.url;
    if (!image.storageKey && isHttpsUrl(image.dataUrl)) return image.dataUrl;
    const blob = image.storageKey ? await getImageBlob(image.storageKey) : image.dataUrl?.startsWith("data:") ? dataUrlToFile(image) : undefined;
    if (!blob) throw new Error(apiText("referenceImageReadFailed"));
    return { file_id: await uploadGatewayFile(config, blob, image.name || "reference-image", options, image.storageKey) };
}

export async function uploadMediaReferences(config: ModelRequestConfig, items: Array<{ url?: string; storageKey?: string; name?: string }> | undefined, options?: RequestOptions): Promise<GatewayMediaReference[]> {
    return Promise.all((items || []).map(async (item) => {
        if (isHttpsUrl(item.url)) return item.url;
        if (!item.storageKey) throw new Error(apiText("localAssetReadFailed"));
        const blob = await getMediaBlob(item.storageKey);
        if (!blob) throw new Error(apiText("localAssetReadFailed"));
        return { file_id: await uploadGatewayFile(config, blob, item.name || "reference-media", options, item.storageKey) };
    }));
}

async function uploadGatewayFile(config: ModelRequestConfig, blob: Blob, filename: string, options?: RequestOptions, storageKey?: string) {
    const family = config.apiFormat === "ark" ? "ark" : "openai";
    const cacheKey = storageKey ? [config.providerId || "", config.authMode || "", family, config.baseUrl, config.apiKey, storageKey].join("\u0000") : undefined;
    if (cacheKey) {
        const cached = gatewayFileCache.get(cacheKey);
        if (cached && (cached.expires_at == null || cached.expires_at * 1000 > Date.now() + 30_000)) return cached.id;
        gatewayFileCache.delete(cacheKey);
        const pending = gatewayFileUploads.get(cacheKey);
        if (pending) return (await pending).id;
    }
    const upload = uploadGatewayFileWithRetry(config, family, blob, filename, options);
    if (cacheKey) gatewayFileUploads.set(cacheKey, upload);
    try {
        const file = await upload;
        if (cacheKey && gatewayFileUploads.get(cacheKey) === upload) gatewayFileCache.set(cacheKey, file);
        return file.id;
    } finally {
        if (cacheKey && gatewayFileUploads.get(cacheKey) === upload) gatewayFileUploads.delete(cacheKey);
    }
}

async function uploadGatewayFileWithRetry(config: ModelRequestConfig, family: "openai" | "ark", blob: Blob, filename: string, options?: RequestOptions): Promise<GatewayFile> {
    const form = new FormData();
    form.append("purpose", "user_data");
    form.append("file", blob, filename);
    for (let attempt = 0; attempt < 3; attempt += 1) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        try {
            const response = await axios.post<GatewayFileResponse>(buildApiUrl(config.baseUrl, "/files"), form, {
                headers: { Authorization: `Bearer ${config.apiKey}`, ...(family === "ark" ? { "X-Video-Protocol": "ark" } : {}) },
                signal: options?.signal,
            });
            const file = response.data.id ? response.data : response.data.data;
            if (!file?.id) throw new Error(readError(response.data) || apiText("referenceUploadFailed"));
            return { id: file.id, expires_at: file.expires_at };
        } catch (error) {
            if (axios.isCancel(error) || !axios.isAxiosError(error)) throw error;
            const status = error.response?.status;
            if ((status && status !== 408 && status !== 429 && status < 500) || attempt === 2) throw new Error(readError(error.response?.data) || apiText("referenceUploadFailed"));
            await delay(500 * 2 ** attempt, options?.signal);
        }
    }
    throw new Error(apiText("referenceUploadFailed"));
}

function readError(value: unknown): string {
    if (typeof value === "string") {
        try { return readError(JSON.parse(value)) || value; } catch { return value; }
    }
    if (!value || typeof value !== "object") return "";
    const payload = value as { msg?: unknown; message?: unknown; error?: unknown };
    return readError(payload.msg) || readError(payload.message) || readError(payload.error);
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
        const onAbort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
        const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function isHttpsUrl(value: string | undefined): value is string {
    return typeof value === "string" && /^https:\/\//i.test(value);
}

export async function isVideoBlob(value: unknown): Promise<boolean> {
    if (!(value instanceof Blob) || value.size === 0) return false;
    const mimeType = value.type.split(";", 1)[0].trim().toLowerCase();
    if (mimeType.startsWith("video/")) return true;
    if (mimeType && mimeType !== "application/octet-stream") return false;
    const bytes = new Uint8Array(await value.slice(0, 12).arrayBuffer());
    return (bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70)
        || (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3);
}
