import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { strictLocalForageStorage } from "@/lib/localforage-storage";
import { cleanupUnusedImages, ensureImagePreview, previewUrlFor, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { cleanupUnusedMedia, resolveMediaUrl } from "@/services/file-storage";

export type AssetKind = "text" | "image" | "video";
export type TextAsset = AssetBase<"text"> & { data: { content: string } };
export type ImageAsset = AssetBase<"image"> & { data: { dataUrl: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type VideoAsset = AssetBase<"video"> & { data: { url: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type Asset = TextAsset | ImageAsset | VideoAsset;

type AssetBase<T extends AssetKind> = {
    id: string;
    kind: T;
    title: string;
    coverUrl: string;
    tags: string[];
    source?: string;
    note?: string;
    createdAt: string;
    updatedAt: string;
    metadata?: Record<string, unknown>;
};

type AssetStore = {
    hydrated: boolean;
    hydrationError: string | null;
    assets: Asset[];
    deletedAssets: Array<{ id: string; deletedAt: string }>;
    addAsset: (asset: Omit<Asset, "id" | "createdAt" | "updatedAt">) => string;
    updateAsset: (id: string, patch: Partial<Omit<Asset, "id" | "createdAt">>) => void;
    removeAsset: (id: string) => void;
    replaceAssets: (assets: Asset[]) => void;
    cleanupImages: (extra?: unknown) => void;
};

let hydrationFailed = false;

const getStorageErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

function recordTime(value: string | undefined) {
    return value ? Date.parse(value) || 0 : 0;
}

function mergePersistedAssets(value: StorageValue<AssetStore>, stored?: StorageValue<AssetStore> | null) {
    if (!stored) return value;
    const assets = new Map((stored.state.assets || []).map((asset) => [asset.id, asset]));
    value.state.assets.forEach((asset) => {
        const previous = assets.get(asset.id);
        if (!previous || recordTime(asset.updatedAt) >= recordTime(previous.updatedAt)) assets.set(asset.id, asset);
    });
    const deletedAssets = new Map((stored.state.deletedAssets || []).map((item) => [item.id, item]));
    value.state.deletedAssets.forEach((item) => {
        const previous = deletedAssets.get(item.id);
        if (!previous || recordTime(item.deletedAt) >= recordTime(previous.deletedAt)) deletedAssets.set(item.id, item);
    });
    const activeAssets = [...assets.values()].filter((asset) => {
        const deleted = deletedAssets.get(asset.id);
        return !deleted || recordTime(asset.updatedAt) > recordTime(deleted.deletedAt);
    });
    return { ...value, state: { ...value.state, assets: activeAssets, deletedAssets: [...deletedAssets.values()] } };
}

// 卡片用缩略图渲染，自定义封面（远程地址或单独上传的封面）保持原样。
export function assetCoverUrl(asset: Asset) {
    const own = asset.kind === "image" ? asset.data.dataUrl : "";
    const cover = asset.coverUrl || own;
    return asset.kind === "image" && cover === own ? previewUrlFor(asset.data.storageKey) || cover : cover;
}

const ASSET_STORE_KEY = "infinite-canvas:asset_store";

const assetStorage: PersistStorage<AssetStore> = {
    getItem: async (name) => {
        const value = await strictLocalForageStorage.getItem(name);
        if (!value) return null;
        const parsed = JSON.parse(value) as StorageValue<AssetStore>;
        parsed.state.deletedAssets ||= [];
        parsed.state.assets = await Promise.all(
            parsed.state.assets.map(async (asset) => {
                if (asset.kind === "video" && asset.data.storageKey) {
                    const url = await resolveMediaUrl(asset.data.storageKey, asset.data.url);
                    return { ...asset, coverUrl: asset.coverUrl.startsWith("blob:") ? url : asset.coverUrl, data: { ...asset.data, url } };
                }
                if (asset.kind === "video" && asset.data.url.startsWith("blob:")) return { ...asset, coverUrl: asset.coverUrl.startsWith("blob:") ? "" : asset.coverUrl, data: { ...asset.data, url: "" } };
                if (asset.kind !== "image") return asset;
                if (asset.data.storageKey) {
                    void ensureImagePreview(asset.data.storageKey);
                    return {
                        ...asset,
                        coverUrl: asset.coverUrl.startsWith("blob:") ? await resolveImageUrl(asset.data.storageKey, asset.coverUrl) : asset.coverUrl,
                        data: { ...asset.data, dataUrl: await resolveImageUrl(asset.data.storageKey, asset.data.dataUrl) },
                    };
                }
                if (asset.data.dataUrl.startsWith("blob:")) return { ...asset, coverUrl: asset.coverUrl.startsWith("blob:") ? "" : asset.coverUrl, data: { ...asset.data, dataUrl: "" } };
                if (!asset.data.dataUrl.startsWith("data:image/")) return asset.coverUrl.startsWith("blob:") ? { ...asset, coverUrl: "" } : asset;
                const image = await uploadImage(asset.data.dataUrl);
                return { ...asset, coverUrl: asset.coverUrl.startsWith("blob:") || asset.coverUrl.startsWith("data:image/") ? image.url : asset.coverUrl, data: { ...asset.data, dataUrl: image.url, storageKey: image.storageKey, bytes: image.bytes, mimeType: image.mimeType } };
            }),
        );
        return parsed;
    },
    setItem: (name, value) => {
        if (hydrationFailed) return Promise.resolve();
        return strictLocalForageStorage
            .getItem(name)
            .then((stored) => mergePersistedAssets(value, stored ? (JSON.parse(stored) as StorageValue<AssetStore>) : null))
            .then((merged) => strictLocalForageStorage.setItem(name, JSON.stringify(merged)))
            .catch((error) => {
                hydrationFailed = true;
                useAssetStore.setState({ hydrated: true, hydrationError: getStorageErrorMessage(error) });
            });
    },
    removeItem: (name) => strictLocalForageStorage.removeItem(name),
};

export const useAssetStore = create<AssetStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            hydrationError: null,
            assets: [],
            deletedAssets: [],
            addAsset: (asset) => {
                if (hydrationFailed) return "";
                const now = new Date().toISOString();
                const id = nanoid();
                set((state) => ({ assets: [{ ...asset, id, createdAt: now, updatedAt: now } as Asset, ...state.assets] }));
                return id;
            },
            updateAsset: (id, patch) => {
                if (hydrationFailed) return;
                set((state) => ({
                    assets: state.assets.map((asset) => (asset.id === id ? ({ ...asset, ...patch, updatedAt: new Date().toISOString() } as Asset) : asset)),
                }));
            },
            removeAsset: (id) => {
                if (hydrationFailed) return;
                set((state) => {
                    const now = new Date().toISOString();
                    const assets = state.assets.filter((asset) => asset.id !== id);
                    get().cleanupImages({ assets });
                    return { assets, deletedAssets: [...state.deletedAssets.filter((item) => item.id !== id), { id, deletedAt: now }] };
                });
            },
            replaceAssets: (assets) => {
                if (hydrationFailed) return;
                set({ assets });
            },
            cleanupImages: (extra) => {
                if (hydrationFailed) return;
                window.setTimeout(async () => {
                    if (hydrationFailed) return;
                    const { useCanvasStore } = await import("@/stores/canvas/use-canvas-store");
                    await cleanupUnusedImages({ assets: get().assets, projects: useCanvasStore.getState().projects, extra });
                    await cleanupUnusedMedia({ assets: get().assets, projects: useCanvasStore.getState().projects, extra });
                }, 0);
            },
        }),
        {
            name: ASSET_STORE_KEY,
            storage: assetStorage,
            partialize: (state) => ({ assets: state.assets, deletedAssets: state.deletedAssets }) as StorageValue<AssetStore>["state"],
            onRehydrateStorage: () => (_state, error) => {
                if (error) {
                    hydrationFailed = true;
                    useAssetStore.setState({ hydrated: true, hydrationError: getStorageErrorMessage(error) });
                    return;
                }
                useAssetStore.setState({ hydrated: true, hydrationError: null });
            },
        },
    ),
);
