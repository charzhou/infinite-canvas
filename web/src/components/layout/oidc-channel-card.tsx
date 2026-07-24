import { Alert, Button } from "antd";

import { useOidcStore } from "@/stores/use-oidc-store";

type Props = { providerName?: string; enabled?: boolean; connected?: boolean };

export function OidcChannelCard({ providerName, enabled, connected }: Props) {
    const state = useOidcStore();
    const name = providerName ?? state.providerName;
    const available = enabled ?? state.enabled;
    const active = connected ?? state.connected;
    if (!available) return null;
    return (
        <section className="mb-4 border-b border-stone-200 pb-4 dark:border-stone-800">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <div className="text-sm font-semibold">{name}</div>
                    <div className="mt-1 text-xs text-stone-500">{active ? "已连接，可使用受管理模型" : "连接后可使用受管理模型"}</div>
                </div>
                {active ? (
                    <div className="flex gap-2">
                        <Button size="small" loading={state.loading} onClick={() => void state.syncModels()}>同步模型</Button>
                        <Button size="small" danger loading={state.loading} onClick={() => void state.disconnect()}>断开 {name}</Button>
                    </div>
                ) : (
                    <Button type="primary" size="small" loading={state.loading} onClick={() => void state.connect()}>{state.error ? `重新连接 ${name}` : `连接 ${name}`}</Button>
                )}
            </div>
            {state.error ? <Alert className="mt-3" type="error" showIcon message={state.error} /> : null}
        </section>
    );
}
