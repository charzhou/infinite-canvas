import { App, Button, Checkbox, Input, Modal, Select } from "antd";
import { KeyRound, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { resolveSub2ApiChannelModels } from "@/lib/sub2api-channel-link";
import { fetchChannelModels } from "@/services/api/image";
import { importSub2ApiChannel, SUB2API_CHANNEL_ID, SUB2API_GATEWAY_BASE_URL, useConfigStore, type ApiCallFormat, type ChannelModel, type ModelCapability } from "@/stores/use-config-store";
import { useOidcStore } from "@/stores/use-oidc-store";

const protocolOptions: Array<{ label: string; value: ApiCallFormat }> = [
    { label: "OpenAI", value: "openai" },
    { label: "xAI", value: "xai" },
    { label: "Gemini", value: "gemini" },
];

export function Sub2ApiApiKeyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const current = useConfigStore((state) => state.config.channels.find((channel) => channel.providerId === "sub2api"));
    const [apiKey, setApiKey] = useState("");
    const [models, setModels] = useState<ChannelModel[]>([]);
    const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());
    const [verifying, setVerifying] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!open) return;
        setApiKey(current?.authMode === "manual" ? current.apiKey : "");
        setModels([]);
        setSelectedNames(new Set());
    }, [current, open]);

    const capabilityOptions: Array<{ label: string; value: ModelCapability }> = ["image", "video", "text", "audio"].map((value) => ({
        label: t(`config.channelEditor.capabilities.${value}`),
        value: value as ModelCapability,
    }));

    const verify = async () => {
        const key = apiKey.trim();
        if (!key) return message.error(t("fork.sub2api.apiKeyRequired"));
        setVerifying(true);
        try {
            const discovered = await fetchChannelModels({ id: SUB2API_CHANNEL_ID, name: "Sub2API", baseUrl: SUB2API_GATEWAY_BASE_URL, apiKey: key, apiFormat: "openai", authMode: "manual", providerId: "sub2api", models: [] });
            const resolved = resolveSub2ApiChannelModels(discovered, { channelId: SUB2API_CHANNEL_ID });
            setModels(resolved);
            setSelectedNames(new Set(resolved.map((model) => model.name)));
        } catch {
            setModels([]);
            setSelectedNames(new Set());
            message.error(t("fork.sub2api.apiKeyVerificationFailed"));
        } finally {
            setVerifying(false);
        }
    };

    const updateModel = (name: string, patch: Partial<ChannelModel>) => setModels((currentModels) => currentModels.map((model) => (model.name === name ? { ...model, ...patch } : model)));
    const toggleModel = (name: string, checked: boolean) => setSelectedNames((currentNames) => {
        const next = new Set(currentNames);
        if (checked) next.add(name);
        else next.delete(name);
        return next;
    });

    const save = async () => {
        const selected = models.filter((model) => selectedNames.has(model.name));
        if (!selected.length) return message.error(t("fork.sub2api.selectAtLeastOneModel"));
        setSaving(true);
        try {
            if (current?.authMode === "oidc") await useOidcStore.getState().disconnectSession();
            useConfigStore.setState((state) => ({ config: importSub2ApiChannel(state.config, { apiKey: apiKey.trim(), descriptor: { channelId: SUB2API_CHANNEL_ID, name: "Sub2API" }, models: selected }) }));
            message.success(t("fork.sub2api.apiKeyConnected"));
            onClose();
        } catch {
            message.error(t("fork.sub2api.connectionSwitchFailed"));
        } finally {
            setSaving(false);
        }
    };

    return (
        <Modal
            open={open}
            width={760}
            title={t("fork.sub2api.apiKeyTitle")}
            onCancel={onClose}
            footer={models.length ? [
                <Button key="cancel" onClick={onClose}>{t("common.cancel")}</Button>,
                <Button key="save" type="primary" loading={saving} disabled={!selectedNames.size} onClick={() => void save()}>{t("fork.sub2api.saveApiKey")}</Button>,
            ] : null}
        >
            <div className="flex gap-2">
                <Input.Password
                    value={apiKey}
                    prefix={<KeyRound className="size-4 text-stone-400" />}
                    placeholder={t("fork.sub2api.apiKeyPlaceholder")}
                    onChange={(event) => {
                        setApiKey(event.target.value);
                        setModels([]);
                        setSelectedNames(new Set());
                    }}
                    onPressEnter={() => void verify()}
                />
                <Button icon={<RefreshCw className="size-4" />} loading={verifying} onClick={() => void verify()}>{t("fork.sub2api.verifyApiKey")}</Button>
            </div>

            {models.length ? (
                <div className="mt-5">
                    <div className="mb-2 flex items-center justify-between gap-3">
                        <span className="text-sm font-medium">{t("fork.sub2api.availableModels")}</span>
                        <span className="text-xs text-stone-500">{t("fork.sub2api.selectedModelCount", { selected: selectedNames.size, total: models.length })}</span>
                    </div>
                    <div className="max-h-[48vh] divide-y divide-stone-200 overflow-y-auto border-y border-stone-200 dark:divide-stone-800 dark:border-stone-800">
                        {models.map((model) => (
                            <div key={model.name} className="grid min-h-14 grid-cols-[minmax(0,1fr)_120px_110px] items-center gap-3 py-2">
                                <Checkbox checked={selectedNames.has(model.name)} onChange={(event) => toggleModel(model.name, event.target.checked)}>
                                    <span className="break-all text-sm">{model.name}</span>
                                </Checkbox>
                                <Select size="small" value={model.capability} options={capabilityOptions} onChange={(capability) => updateModel(model.name, { capability })} />
                                <Select size="small" value={model.apiFormat || "openai"} options={protocolOptions} onChange={(apiFormat) => updateModel(model.name, { apiFormat })} />
                            </div>
                        ))}
                    </div>
                </div>
            ) : null}
        </Modal>
    );
}
