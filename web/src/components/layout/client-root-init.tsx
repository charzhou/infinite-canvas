import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { App } from "antd";
import axios from "axios";

import { isSub2ApiChannelLinkPath } from "@/lib/sub2api-channel-link-bootstrap";
import { createModelChannel, useConfigStore } from "@/stores/use-config-store";
import { usePromptSourceScheduler } from "@/hooks/use-prompt-source-scheduler";
import { useOidcStore } from "@/stores/use-oidc-store";

type OidcAuthorizationResult = "failed" | "invalid_scope";

function takeOidcAuthorizationResult(): OidcAuthorizationResult | null {
    const searchParams = new URLSearchParams(window.location.search);
    const result = searchParams.get("oidc");
    if (!result) return null;
    searchParams.delete("oidc");
    window.history.replaceState(null, "", `${window.location.pathname}${searchParams.size ? `?${searchParams}` : ""}${window.location.hash}`);
    return result === "invalid_scope" || result === "failed" ? result : null;
}

export function ClientRootInit({ children }: { children: ReactNode }) {
    const { message } = App.useApp();
    const handledConfigParams = useRef(false);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const config = useConfigStore((state) => state.config);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);

    usePromptSourceScheduler();

    useEffect(() => {
        const authorizationResult = takeOidcAuthorizationResult();
        void useOidcStore.getState().refresh().finally(() => {
            if (authorizationResult) useOidcStore.getState().reportAuthorizationResult(authorizationResult);
        });
        const interceptor = axios.interceptors.response.use(
            (response) => response,
            (error) => {
                if (error.response?.headers?.["x-oidc-session-invalid"] === "1" && useOidcStore.getState().connected) {
                    useOidcStore.getState().invalidate();
                    message.warning("受管理渠道的授权已失效，请重新连接");
                }
                return Promise.reject(error);
            },
        );
        return () => axios.interceptors.response.eject(interceptor);
    }, [message]);

    useEffect(() => {
        if (handledConfigParams.current) return;
        if (isSub2ApiChannelLinkPath(window.location.pathname)) return;
        const searchParams = new URLSearchParams(window.location.search);
        const baseUrl = searchParams.get("baseUrl") || searchParams.get("baseurl");
        const apiKey = searchParams.get("apiKey") || searchParams.get("apikey");
        if (!baseUrl && !apiKey) return;
        handledConfigParams.current = true;
        searchParams.delete("baseUrl");
        searchParams.delete("baseurl");
        searchParams.delete("apiKey");
        searchParams.delete("apikey");
        window.history.replaceState(null, "", `${window.location.pathname}${searchParams.size ? `?${searchParams}` : ""}${window.location.hash}`);
        const firstChannel = config.channels[0];
        updateConfig(
            "channels",
            firstChannel
                ? config.channels.map((channel, index) =>
                      index === 0
                          ? {
                                ...channel,
                                ...(baseUrl ? { baseUrl } : {}),
                                ...(apiKey ? { apiKey } : {}),
                            }
                          : channel,
                  )
                : [createModelChannel({ id: "default", name: "默认渠道", baseUrl: baseUrl || undefined, apiKey: apiKey || "" })],
        );
        if (baseUrl) updateConfig("baseUrl", baseUrl);
        if (apiKey) updateConfig("apiKey", apiKey);
        openConfigDialog(false);
        message.success("已导入本地直连配置");
    }, [config.channels, message, openConfigDialog, updateConfig]);

    return <>{children}</>;
}
