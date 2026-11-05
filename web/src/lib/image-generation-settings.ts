export const imageGenerationDefaults = {
    imageOutputFormat: "png",
    imageComplexity: "auto",
    imageFrameCount: "9",
    imageFrameDurationMs: "200",
    imageOutputCompression: "",
    imageSvgModel: "",
    imageSvgReasoningEffort: "auto",
};

export type ImageGenerationSettings = typeof imageGenerationDefaults;
export const imageGenerationKeys = Object.keys(imageGenerationDefaults) as (keyof ImageGenerationSettings)[];
export const imageSettingKeys = ["quality", "size", "background", ...imageGenerationKeys] as const;
export type ImageSettingKey = (typeof imageSettingKeys)[number] | "count";
export type ImageOutputFormat = "png" | "jpeg" | "webp" | "gif" | "svg";

export function pickImageGenerationSettings(config: Partial<ImageGenerationSettings>, overrides?: Partial<ImageGenerationSettings>): ImageGenerationSettings {
    return Object.fromEntries(imageGenerationKeys.map((key) => [key, overrides?.[key] ?? config[key] ?? imageGenerationDefaults[key]])) as ImageGenerationSettings;
}

export function supportsImage26(model: string) {
    return /gpt-image-2\.6-(sunburst|flare)(?:$|-)/.test(model);
}

export function supportsImageMarkup(model: string) {
    return /gpt-image-2\.[56]-(sunburst|flare)(?:$|-)/.test(model);
}

export function imageOutputFormat(model: string, format: string): ImageOutputFormat {
    if (/gpt-image/.test(model) && ["png", "jpeg", "webp"].includes(format)) return format as ImageOutputFormat;
    return supportsImage26(model) && ["gif", "svg"].includes(format) ? format as ImageOutputFormat : "png";
}

export function imageMimeType(format: string) {
    return `image/${format === "svg" ? "svg+xml" : format}`;
}

export function imageFileExtension(mimeTypeOrUrl: string) {
    const subtype = mimeTypeOrUrl.match(/image\/([^;,]+)/)?.[1]?.split("+")[0];
    return subtype === "jpeg" ? "jpg" : subtype || "png";
}
