import { useEffect, useRef, useState } from "react";
import { Spin, theme } from "antd";
import { CircleAlert } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { consumeSub2ApiChannelLinkSearch } from "@/lib/sub2api-channel-link-bootstrap";
import { clearSub2ApiChannelLink, readSub2ApiChannelLink, resolveSub2ApiChannelModels } from "@/lib/sub2api-channel-link";
import { fetchChannelModels } from "@/services/api/image";
import { importSub2ApiChannel, SUB2API_GATEWAY_BASE_URL, useConfigStore } from "@/stores/use-config-store";

type Status = "loading" | "failed";

async function importLink(sourceSearch: string) {
    const { apiKey, descriptor } = readSub2ApiChannelLink(sourceSearch);
    const discovered = await fetchChannelModels({
        id: descriptor.channelId,
        name: descriptor.name || "Sub2API",
        baseUrl: SUB2API_GATEWAY_BASE_URL,
        apiKey,
        apiFormat: "openai",
        authMode: "manual",
        providerId: "sub2api",
        models: [],
    });
    const models = resolveSub2ApiChannelModels(discovered, descriptor);
    useConfigStore.setState((state) => ({ config: importSub2ApiChannel(state.config, { apiKey, descriptor, models }) }));
}

export default function Sub2ApiConnectPage() {
    const navigate = useNavigate();
    const handled = useRef(false);
    const [status, setStatus] = useState<Status>("loading");
    const { token } = theme.useToken();

    useEffect(() => {
        if (handled.current) return;
        handled.current = true;
        const sourceSearch = consumeSub2ApiChannelLinkSearch();
        const cleanSearch = clearSub2ApiChannelLink(sourceSearch);
        window.history.replaceState(null, "", `${window.location.pathname}${cleanSearch}${window.location.hash}`);
        void importLink(sourceSearch)
            .then(() => navigate("/", { replace: true }))
            .catch(() => setStatus("failed"));
    }, [navigate]);

    return (
        <main className="flex min-h-screen items-center justify-center px-6" style={{ background: token.colorBgLayout, color: token.colorText }}>
            {status === "loading" ? (
                <div className="flex items-center gap-3 text-sm" role="status">
                    <Spin size="small" />
                    <span>正在验证渠道授权...</span>
                </div>
            ) : (
                <div className="flex max-w-sm flex-col items-center text-center">
                    <CircleAlert aria-hidden size={32} strokeWidth={1.75} color={token.colorError} />
                    <h1 className="mt-4 text-lg font-medium">授权失败</h1>
                    <p className="mt-2 text-sm" style={{ color: token.colorTextSecondary }}>
                        无法验证渠道授权，请返回来源页面重新发起。
                    </p>
                </div>
            )}
        </main>
    );
}
