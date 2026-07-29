import { Alert, Button, Checkbox, Modal, Tag } from "antd";
import { useState } from "react";

import type { OidcModel } from "@/services/api/oidc";
import { useOidcStore } from "@/stores/use-oidc-store";

type Props = { providerName?: string; enabled?: boolean; connected?: boolean };

export function OidcChannelCard({ providerName, enabled, connected }: Props) {
    const state = useOidcStore();
    const [catalog, setCatalog] = useState<OidcModel[]>([]);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [pickerOpen, setPickerOpen] = useState(false);
    const name = providerName ?? state.providerName;
    const available = enabled ?? state.enabled;
    const active = connected ?? state.connected;
    if (!available) return null;
    const openModelPicker = async () => {
        try {
            const models = await state.loadModelCatalog();
            setCatalog(models);
            setSelectedIds(active ? state.modelIds : []);
            setPickerOpen(true);
        } catch {
            // The store exposes the request error in the channel card.
        }
    };
    const beginAuthorization = () => {
        setPickerOpen(false);
        void state.connect(selectedIds);
    };
    return (
        <section className="mb-4 border-b border-stone-200 pb-4 dark:border-stone-800">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <div className="text-sm font-semibold">{name}</div>
                    <div className="mt-1 text-xs text-stone-500">{active ? "已连接，可使用受管理模型" : "连接后可使用受管理模型"}</div>
                </div>
                {active ? (
                    <div className="flex gap-2">
                        <Button size="small" loading={state.loading} onClick={() => void openModelPicker()}>更换模型</Button>
                        <Button size="small" danger loading={state.loading} onClick={() => void state.disconnect()}>断开 {name}</Button>
                    </div>
                ) : (
                    <Button type="primary" size="small" loading={state.loading} onClick={() => void openModelPicker()}>{state.error ? `重新连接 ${name}` : `连接 ${name}`}</Button>
                )}
            </div>
            {state.error ? <Alert className="mt-3" type="error" showIcon message={state.error} /> : null}
            <Modal
                open={pickerOpen}
                title={`选择 ${name} 模型`}
                okText="授权连接"
                cancelText="取消"
                okButtonProps={{ disabled: !selectedIds.length, loading: state.loading }}
                onCancel={() => setPickerOpen(false)}
                onOk={beginAuthorization}
            >
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {catalog.map((model) => (
                        <Checkbox
                            key={model.id}
                            checked={selectedIds.includes(model.id)}
                            onChange={(event) => setSelectedIds((current) => event.target.checked ? [...current, model.id] : current.filter((id) => id !== model.id))}
                        >
                            <span className="mr-2 text-sm">{model.name}</span>
                            <Tag>{model.capability === "image" ? "生图" : model.capability === "video" ? "视频" : "文本"}</Tag>
                        </Checkbox>
                    ))}
                </div>
            </Modal>
        </section>
    );
}
