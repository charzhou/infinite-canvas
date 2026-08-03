import { type ApiCallFormat, type ChannelModel, type ModelCapability, guessCapability } from "@/stores/use-config-store";

export type Sub2ApiChannelDescriptor = {
    channelId: string;
    name?: string;
    models?: Array<{ name: string; capability?: ModelCapability; apiFormat?: ApiCallFormat }>;
    defaults?: Partial<Record<ModelCapability, string>>;
};

const capabilities = new Set<ModelCapability>(["image", "video", "text", "audio"]);
const apiFormats = new Set<ApiCallFormat>(["openai", "gemini", "xai", "ark"]);
const invalidLink = () => new Error("Sub2API 授权链接无效");

export function readSub2ApiChannelLink(search: string): { apiKey: string; descriptor: Sub2ApiChannelDescriptor } {
    const params = new URLSearchParams(search);
    const apiKeys = params.getAll("apiKey");
    const channels = params.getAll("channel");
    if (apiKeys.length !== 1 || channels.length !== 1 || !apiKeys[0].trim() || !channels[0]) throw invalidLink();

    try {
        return { apiKey: apiKeys[0], descriptor: parseDescriptor(decodeBase64Url(channels[0])) };
    } catch {
        throw invalidLink();
    }
}

export function clearSub2ApiChannelLink(search: string) {
    const params = new URLSearchParams(search);
    params.delete("apiKey");
    params.delete("channel");
    const value = params.toString();
    return value ? `?${value}` : "";
}

export function resolveSub2ApiChannelModels(discovered: string[], descriptor: Sub2ApiChannelDescriptor): ChannelModel[] {
    const names = [...new Set(discovered)];
    if (!names.length) throw new Error("Sub2API 未返回可用模型");

    const models = descriptor.models
        ? descriptor.models.filter((model) => names.includes(model.name)).map((model) => ({ name: model.name, capability: model.capability || guessCapability(model.name), ...(model.apiFormat ? { apiFormat: model.apiFormat } : {}) }))
        : names.map((name) => ({ name, capability: guessCapability(name) }));

    if (!models.length) throw new Error("Sub2API 未返回可用模型");
    if (Object.entries(descriptor.defaults || {}).some(([capability, name]) => !models.some((model) => model.name === name && model.capability === capability))) throw new Error("默认模型不可用");
    return models;
}

function decodeBase64Url(value: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw invalidLink();
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function parseDescriptor(value: string): Sub2ApiChannelDescriptor {
    const descriptor = JSON.parse(value);
    if (!isRecord(descriptor) || !onlyKeys(descriptor, ["channelId", "name", "models", "defaults"]) || typeof descriptor.channelId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(descriptor.channelId)) throw invalidLink();

    const name = optionalName(descriptor.name);
    const models = descriptor.models === undefined ? undefined : parseModels(descriptor.models);
    const defaults = descriptor.defaults === undefined ? undefined : parseDefaults(descriptor.defaults, models);
    return { channelId: descriptor.channelId, ...(name ? { name } : {}), ...(models ? { models } : {}), ...(defaults ? { defaults } : {}) };
}

function parseModels(value: unknown): Sub2ApiChannelDescriptor["models"] {
    if (!Array.isArray(value)) throw invalidLink();
    const names = new Set<string>();
    return value.map((model) => {
        if (!isRecord(model) || !onlyKeys(model, ["name", "capability", "apiFormat"])) throw invalidLink();
        const name = requiredName(model.name);
        if (names.has(name)) throw invalidLink();
        names.add(name);
        if (model.capability !== undefined && (typeof model.capability !== "string" || !capabilities.has(model.capability as ModelCapability))) throw invalidLink();
        if (model.apiFormat !== undefined && (typeof model.apiFormat !== "string" || !apiFormats.has(model.apiFormat as ApiCallFormat))) throw invalidLink();
        return { name, ...(model.capability ? { capability: model.capability as ModelCapability } : {}), ...(model.apiFormat ? { apiFormat: model.apiFormat as ApiCallFormat } : {}) };
    });
}

function parseDefaults(value: unknown, models: Sub2ApiChannelDescriptor["models"]): Sub2ApiChannelDescriptor["defaults"] {
    if (!isRecord(value) || Object.keys(value).some((key) => !capabilities.has(key as ModelCapability))) throw invalidLink();
    return Object.fromEntries(Object.entries(value).map(([capability, name]) => {
        const model = requiredName(name);
        if (models && !models.some((item) => item.name === model)) throw invalidLink();
        return [capability, model];
    })) as Sub2ApiChannelDescriptor["defaults"];
}

function optionalName(value: unknown) {
    if (value === undefined) return undefined;
    return requiredName(value);
}

function requiredName(value: unknown) {
    if (typeof value !== "string" || !value.trim()) throw invalidLink();
    return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: string[]) {
    return Object.keys(value).every((key) => keys.includes(key));
}
