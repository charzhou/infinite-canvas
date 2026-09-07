import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { App } from "antd";
import axios from "axios";
import { useTranslation } from "react-i18next";

import { isSub2ApiChannelLinkPath } from "@/lib/sub2api-channel-link-bootstrap";
import { useConfigStore } from "@/stores/use-config-store";
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
    const { t } = useTranslation();
    const handledConfigParams = useRef(false);
    const importChannelCredentials = useConfigStore((state) => state.importChannelCredentials);
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
                    message.warning(t("fork.oidc.sessionInvalid"));
                }
                return Promise.reject(error);
            },
        );
        return () => axios.interceptors.response.eject(interceptor);
    }, [message, t]);

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
        const result = importChannelCredentials({ baseUrl, apiKey });
        openConfigDialog(false, "channels");
        if (result.status === "created") message.success(t("config.importedChannelCreated", { name: result.channelName }));
        else if (result.status === "updated") message.success(t("config.importedChannelUpdated", { name: result.channelName }));
        else if (result.status === "missing-base-url") message.error(t("config.importedChannelBaseUrlRequired"));
        else message.error(t("config.importedChannelBaseUrlInvalid"));
    }, [importChannelCredentials, message, openConfigDialog, t]);

    return <>{children}</>;
}
