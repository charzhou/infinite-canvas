import axios from "axios";

import i18n from "@/i18n";
import { clampVideoSeconds, inferVideoRatio, parseVideoResolution } from "@/lib/media-size";
import { boolConfig, modelOptionName, withLocalProxy, type ModelRequestConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import { isVideoBlob, uploadImageReference, uploadMediaReferences, type GatewayMediaReference } from "./sub2api-media";
import type { VideoGenerationTask, VideoGenerationTaskState } from "./video";

type RequestOptions = { signal?: AbortSignal; videos?: ReferenceVideo[]; audios?: ReferenceAudio[] };
type ArkTaskResponse = { id: string; status: string; content?: { video_url?: string }; error?: { code?: string; message?: string } };
const statuses = new Set(["queued", "running", "succeeded", "failed", "expired"]);
const apiText = (key: string) => i18n.t(`apiErrors.${key}`);
const arkText = (key: string) => i18n.t(`fork.video.${key}`);

export async function createSub2ApiArkVideoTask(config: ModelRequestConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const referenceMode = config.videoMode === "reference";
    if (!referenceMode && (options?.videos?.length || options?.audios?.length)) throw new Error(arkText("arkFramesReferencesUnsupported"));
    if (references.length > (referenceMode ? 9 : 2) || (options?.videos?.length || 0) > 3 || (options?.audios?.length || 0) > 3) throw new Error(arkText("arkReferenceLimit"));
    const [images, videos, audios] = await Promise.all([
        Promise.all(references.map((image) => uploadImageReference(config, image, options))),
        uploadMediaReferences(config, options?.videos, options),
        uploadMediaReferences(config, options?.audios, options),
    ]);
    const content = [
        { type: "text", text: prompt },
        ...images.map((ref, index) => ({ type: "image_url", role: referenceMode ? "reference_image" : index === 0 ? "first_frame" : "last_frame", image_url: carrier(ref) })),
        ...videos.map((ref) => ({ type: "video_url", role: "reference_video", video_url: carrier(ref) })),
        ...audios.map((ref) => ({ type: "audio_url", role: "reference_audio", audio_url: carrier(ref) })),
    ];
    const ratio = inferVideoRatio(config.size);
    const resolution = parseVideoResolution(config.vquality);
    try {
        const { data } = await axios.post<ArkTaskResponse>(arkUrl(config), {
            model: modelOptionName(model), content,
            duration: Number(clampVideoSeconds(config.videoSeconds)),
            resolution: resolution === "2160" ? "4k" : `${resolution}p`,
            ...(ratio !== "auto" ? { ratio } : {}),
            generate_audio: boolConfig(config.videoGenerateAudio, true),
        }, requestOptions(config, true, options));
        assertTask(data);
        return { id: data.id, provider: "ark", model, adapter: "sub2api" };
    } catch (error) {
        if (isCanceled(error, options?.signal)) throw error;
        if (axios.isAxiosError(error) && (!error.response || error.response.status === 408 || error.response.status >= 500)) throw new Error(arkText("arkTaskCreateUncertain"));
        throw new Error(responseMessage(error, apiText("videoTaskCreateFailed")));
    }
}

export async function pollSub2ApiArkVideoTask(config: ModelRequestConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    let data: ArkTaskResponse;
    try {
        data = (await axios.get<ArkTaskResponse>(arkUrl(config, task.id), requestOptions(config, false, options))).data;
    } catch (error) {
        if (isCanceled(error, options?.signal)) throw error;
        if (axios.isAxiosError<{ error?: { code?: string; message?: string } }>(error)) {
            if (error.response?.status === 503 && error.response.data?.error?.code === "video_polling_paused") {
                throw Object.assign(new Error(arkText("arkPollingPaused")), { name: "VideoPollingPaused" });
            }
            const status = error.response?.status;
            if (!status || status === 408 || status === 429 || status >= 500) {
                throw retryableError(responseMessage(error, apiText("videoTaskQueryFailed")), error.response?.headers?.["retry-after"]);
            }
        }
        throw new Error(responseMessage(error, apiText("videoTaskQueryFailed")));
    }
    assertTask(data, task.id);
    if (data.status === "queued" || data.status === "running") return { status: "pending" };
    if (data.status === "failed" || data.status === "expired") return { status: "failed", error: data.error?.message || data.error?.code || apiText("videoGenerationFailed") };
    const url = data.content?.video_url;
    if (!url || !/^https:\/\//i.test(url)) throw new Error(arkText("arkInvalidResponse"));
    try {
        const response = await axios.get<Blob>(withLocalProxy(url), { responseType: "blob", signal: options?.signal });
        if (!(await isVideoBlob(response.data))) throw new Error(apiText("videoDownloadFailed"));
        return { status: "completed", result: { blob: response.data } };
    } catch (error) {
        if (isCanceled(error, options?.signal)) throw error;
        if (axios.isAxiosError(error)) {
            const status = error.response?.status;
            if (!status || [401, 403, 404, 408, 410, 429].includes(status) || status >= 500) throw retryableError(apiText("videoDownloadFailed"));
        }
        throw new Error(apiText("videoDownloadFailed"));
    }
}

function arkUrl(config: ModelRequestConfig, id?: string) {
    return withLocalProxy(`${config.baseUrl.trim().replace(/\/+$/, "")}/api/v3/contents/generations/tasks${id ? `/${encodeURIComponent(id)}` : ""}`);
}

function requestOptions(config: ModelRequestConfig, json: boolean, options?: RequestOptions) {
    return { headers: { ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}), ...(json ? { "Content-Type": "application/json" } : {}) }, signal: options?.signal };
}

function carrier(ref: GatewayMediaReference) {
    return typeof ref === "string" ? { url: ref } : ref;
}

function assertTask(data: ArkTaskResponse, expectedId?: string) {
    if (!data || typeof data.id !== "string" || !/^video_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.id) || (expectedId && data.id !== expectedId) || !statuses.has(data.status)) {
        throw new Error(arkText("arkInvalidResponse"));
    }
}

function isCanceled(error: unknown, signal?: AbortSignal) {
    return signal?.aborted || axios.isCancel(error) || (error instanceof DOMException && error.name === "AbortError");
}

function responseMessage(error: unknown, fallback: string) {
    if (axios.isAxiosError<{ error?: { message?: string }; message?: string }>(error)) return error.response?.data?.error?.message || error.response?.data?.message || fallback;
    return error instanceof Error ? error.message : fallback;
}

function retryableError(message: string, retryAfter?: string | number) {
    const seconds = Number(retryAfter);
    const wait = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(String(retryAfter)) - Date.now();
    return Object.assign(new Error(message), { name: "VideoPollingRetryable", ...(Number.isFinite(wait) ? { retryAfterMs: Math.max(0, Math.min(30_000, wait)) } : {}) });
}
