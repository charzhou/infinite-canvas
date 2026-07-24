import { create } from "zustand";

import { beginOidcAuthorization, disconnectOidc, getOidcConfig, getOidcModels, getOidcSession } from "@/services/api/oidc";
import { removeOidcChannel, syncManagedOidcChannel, useConfigStore } from "@/stores/use-config-store";

type OidcState = {
    enabled: boolean;
    providerName: string;
    connected: boolean;
    loading: boolean;
    error: string;
    refresh: () => Promise<void>;
    connect: () => Promise<void>;
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
    loading: false,
    error: "",
    refresh: async () => {
        set({ loading: true, error: "" });
        try {
            const publicConfig = await getOidcConfig();
            if (!publicConfig.enabled) {
                removeManagedChannel();
                return set({ enabled: false, providerName: "", connected: false, loading: false });
            }
            const session = await getOidcSession().catch(() => ({ connected: false, providerName: publicConfig.providerName, approvedScopes: [] }));
            set({ enabled: true, providerName: publicConfig.providerName, connected: session.connected });
            if (session.connected) await get().syncModels();
            else removeManagedChannel();
        } catch (error) {
            removeManagedChannel();
            set({ connected: false, error: error instanceof Error ? error.message : "OIDC 状态读取失败" });
        } finally {
            set({ loading: false });
        }
    },
    connect: async () => {
        set({ loading: true, error: "" });
        try {
            await beginOidcAuthorization("/config");
        } catch (error) {
            set({ error: error instanceof Error ? error.message : "OIDC 授权发起失败", loading: false });
        }
    },
    syncModels: async () => {
        set({ loading: true, error: "" });
        try {
            const models = await getOidcModels();
            const { providerName } = get();
            useConfigStore.setState((state) => ({ config: syncManagedOidcChannel(state.config, { id: "oidc", name: providerName, baseUrl: "/api/oidc/proxy", apiKey: "", apiFormat: "openai", authMode: "oidc", models }) }));
            set({ connected: true });
        } catch (error) {
            removeManagedChannel();
            set({ connected: false, error: error instanceof Error ? error.message : "OIDC 模型同步失败" });
        } finally {
            set({ loading: false });
        }
    },
    disconnect: async () => {
        set({ loading: true, error: "" });
        try {
            await disconnectOidc();
            removeManagedChannel();
            set({ connected: false });
        } catch (error) {
            set({ error: error instanceof Error ? error.message : "OIDC 断开失败" });
        } finally {
            set({ loading: false });
        }
    },
    invalidate: () => {
        removeManagedChannel();
        set({ connected: false, error: "" });
    },
}));
