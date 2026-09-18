import { Alert, App, Button, Checkbox, Modal, Tag } from "antd";
import { KeyRound, LogIn, Unplug } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { OidcModel } from "@/services/api/oidc";
import { removeSub2ApiChannel, useConfigStore } from "@/stores/use-config-store";
import { useOidcStore } from "@/stores/use-oidc-store";
import { Sub2ApiApiKeyModal } from "./sub2api-api-key-modal";

export function Sub2ApiChannelCard() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const state = useOidcStore();
    const current = useConfigStore((store) => store.config.channels.find((channel) => channel.providerId === "sub2api"));
    const [catalog, setCatalog] = useState<OidcModel[]>([]);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [apiKeyOpen, setApiKeyOpen] = useState(false);
    const connectionType = current?.authMode === "oidc" ? t("fork.sub2api.oidcConnection") : current ? t("fork.sub2api.apiKeyConnection") : t("fork.sub2api.notConnected");

    const openModelPicker = async () => {
        if (!state.enabled) return;
        try {
            const models = await state.loadModelCatalog();
            setCatalog(models);
            setSelectedIds(current?.authMode === "oidc" ? state.modelIds : []);
            setPickerOpen(true);
        } catch {
            // The store renders the request error below.
        }
    };

    const beginAuthorization = () => {
        setPickerOpen(false);
        void state.connect(selectedIds);
    };

    const disconnect = async () => {
        try {
            if (current?.authMode === "oidc") await state.disconnect();
            else useConfigStore.setState((store) => ({ config: removeSub2ApiChannel(store.config) }));
            message.success(t("fork.sub2api.disconnected"));
        } catch {
            // OIDC errors are rendered by the store.
        }
    };

    return (
        <section className="mb-4 border-b border-stone-200 pb-4 dark:border-stone-800">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                    <div className="text-sm font-semibold">Sub2API</div>
                    <div className="mt-1 truncate text-xs text-stone-500">
                        {current ? `${connectionType} · ${current.name} · ${t("config.channels.modelCount", { count: current.models.length })}` : connectionType}
                    </div>
                </div>
                <div className="flex flex-wrap gap-2">
                    <Button size="small" icon={<LogIn className="size-3.5" />} disabled={!state.enabled} loading={state.loading} onClick={() => void openModelPicker()} title={!state.enabled ? t("fork.sub2api.oidcUnavailable") : undefined}>
                        {t("fork.sub2api.authorizeConnection")}
                    </Button>
                    <Button size="small" icon={<KeyRound className="size-3.5" />} onClick={() => setApiKeyOpen(true)}>{t("fork.sub2api.useApiKey")}</Button>
                    {current ? <Button size="small" danger type="text" icon={<Unplug className="size-3.5" />} loading={state.loading} onClick={() => void disconnect()}>{t("fork.sub2api.disconnect")}</Button> : null}
                </div>
            </div>
            {!state.enabled ? <div className="mt-2 text-xs text-stone-500">{t("fork.sub2api.oidcUnavailable")}</div> : null}
            {state.enabled && state.error ? <Alert className="mt-3" type="error" showIcon title={state.error} /> : null}

            <Modal
                open={pickerOpen}
                title={t("fork.oidc.selectProviderModels", { name: state.providerName || "Sub2API" })}
                okText={t("fork.oidc.authorize")}
                cancelText={t("common.cancel")}
                okButtonProps={{ disabled: !selectedIds.length, loading: state.loading }}
                onCancel={() => setPickerOpen(false)}
                onOk={beginAuthorization}
            >
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {catalog.map((model) => (
                        <Checkbox key={model.id} checked={selectedIds.includes(model.id)} onChange={(event) => setSelectedIds((currentIds) => event.target.checked ? [...currentIds, model.id] : currentIds.filter((id) => id !== model.id))}>
                            <span className="mr-2 text-sm">{model.name}</span>
                            <Tag>{t(`config.channelEditor.capabilities.${model.capability}`)}</Tag>
                        </Checkbox>
                    ))}
                </div>
            </Modal>

            <Sub2ApiApiKeyModal open={apiKeyOpen} onClose={() => setApiKeyOpen(false)} />
        </section>
    );
}
