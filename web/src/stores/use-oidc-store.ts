import { create } from "zustand";

import { beginOidcAuthorization, disconnectOidc, getOidcConfig, getOidcModelCatalog, getOidcModels, getOidcSession, type OidcModel } from "@/services/api/oidc";
import { removeOidcChannel, syncManagedOidcChannel, useConfigStore } from "@/stores/use-config-store";

type OidcState = {
    enabled: boolean;
    providerName: string;
    connected: boolean;
    modelIds: string[];
    loading: boolean;
    error: string;
    refresh: () => Promise<void>;
    loadModelCatalog: () => Promise<OidcModel[]>;
    connect: (modelIds: string[]) => Promise<void>;
    reportAuthorizationResult: (result: "failed" | "invalid_scope") => void;
    syncModels: () => Promise<void>;
    disconnect: () => Promise<void>;
    invalidate: () => void;
};

function removeManagedChannel() {
    useConfigStore.setState((state) => ({ config: removeOidcChannel(state.config) }));
}

export const useOidcStore = create<OidcState>((set, get) => ({
    enabled: false,
    providerName: "",
    connected: false,
    modelIds: [],
    loading: false,
    error: "",
    refresh: async () => {
        set({ loading: true, error: "" });
        try {
            const publicConfig = await getOidcConfig();
            if (!publicConfig.enabled) {
                removeManagedChannel();
                return set({ enabled: false, providerName: "", connected: false, modelIds: [], loading: false });
            }
            const session = await getOidcSession().catch(() => ({ connected: false, providerName: publicConfig.providerName, approvedScopes: [] }));
            set({ enabled: true, providerName: publicConfig.providerName, connected: session.connected });
            if (session.connected) await get().syncModels();
            else {
                removeManagedChannel();
                set({ modelIds: [] });
            }
        } catch (error) {
            removeManagedChannel();
            set({ connected: false, modelIds: [], error: error instanceof Error ? error.message : "OIDC 状态读取失败" });
        } finally {
            set({ loading: false });
        }
    },
    loadModelCatalog: async () => {
        set({ loading: true, error: "" });
        try {
            return await getOidcModelCatalog();
        } catch (error) {
            set({ error: error instanceof Error ? error.message : "OIDC 模型目录读取失败" });
            throw error;
        } finally {
            set({ loading: false });
        }
    },
    connect: async (modelIds) => {
        set({ loading: true, error: "" });
        try {
            await beginOidcAuthorization(modelIds, "/config");
        } catch (error) {
            set({ error: error instanceof Error ? error.message : "OIDC 授权发起失败", loading: false });
        }
    },
    reportAuthorizationResult: (result) => set({ error: result === "invalid_scope" ? "所选模型未获此 OAuth 客户端允许，请检查 Sub2API OAuth Client 的 allowed_llm_scopes。" : "OIDC 授权失败，请重新选择模型后连接。" }),
    syncModels: async () => {
        set({ loading: true, error: "" });
        try {
            const models = await getOidcModels();
            const { providerName } = get();
            useConfigStore.setState((state) => ({ config: syncManagedOidcChannel(state.config, { id: "oidc", name: providerName, baseUrl: "/api/oidc/proxy", apiKey: "", apiFormat: "openai", authMode: "oidc", providerId: "sub2api", models }) }));
            set({ connected: true, modelIds: models.map((model) => model.id) });
        } catch (error) {
            removeManagedChannel();
            set({ connected: false, modelIds: [], error: error instanceof Error ? error.message : "OIDC 模型同步失败" });
        } finally {
            set({ loading: false });
        }
    },
    disconnect: async () => {
        set({ loading: true, error: "" });
        try {
            await disconnectOidc();
            removeManagedChannel();
            set({ connected: false, modelIds: [] });
        } catch (error) {
            set({ error: error instanceof Error ? error.message : "OIDC 断开失败" });
        } finally {
            set({ loading: false });
        }
    },
    invalidate: () => {
        removeManagedChannel();
        set({ connected: false, modelIds: [], error: "" });
    },
}));
