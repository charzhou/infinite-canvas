import { App, Button, Input, Modal, Space } from "antd";
import { useEffect, useState } from "react";

import type { PersonalPrompt, PersonalPromptInput } from "@/stores/use-prompt-store";

const EMPTY_PROMPT: PersonalPromptInput = {
    title: "",
    prompt: "",
    description: "",
    coverUrl: "",
    referenceImageUrls: [],
    tags: [],
};

export function MyPromptEditorDialog({ open, prompt, onSave, onClose }: { open: boolean; prompt: PersonalPrompt | null; onSave: (value: PersonalPromptInput) => void; onClose: () => void }) {
    const { message } = App.useApp();
    const [draft, setDraft] = useState<PersonalPromptInput>(EMPTY_PROMPT);
    const [tags, setTags] = useState("");
    const [referenceImages, setReferenceImages] = useState("");

    useEffect(() => {
        if (!open) return;
        setDraft(prompt ? toInput(prompt) : EMPTY_PROMPT);
        setTags(prompt?.tags.join(", ") || "");
        setReferenceImages(prompt?.referenceImageUrls.join("\n") || "");
    }, [open, prompt]);

    const patch = (value: Partial<PersonalPromptInput>) => setDraft((current) => ({ ...current, ...value }));
    const save = () => {
        if (!draft.title.trim()) return message.warning("请输入标题");
        if (!draft.prompt.trim()) return message.warning("请输入提示词");
        onSave({
            ...draft,
            title: draft.title.trim(),
            prompt: draft.prompt.trim(),
            description: draft.description.trim(),
            coverUrl: draft.coverUrl.trim(),
            tags: splitValues(tags, /[,，\n]/),
            referenceImageUrls: splitValues(referenceImages, /\n/),
        });
        onClose();
    };

    return (
        <Modal
            title={prompt ? "编辑提示词" : "新增提示词"}
            open={open}
            onCancel={onClose}
            width={680}
            footer={
                <Space>
                    <Button onClick={onClose}>取消</Button>
                    <Button type="primary" onClick={save}>
                        保存
                    </Button>
                </Space>
            }
        >
            <div className="grid gap-4 pt-2">
                <label>
                    <span className="mb-1.5 block text-sm font-medium">标题</span>
                    <Input value={draft.title} onChange={(event) => patch({ title: event.target.value })} placeholder="例如：白底商品图" />
                </label>
                <label>
                    <span className="mb-1.5 block text-sm font-medium">提示词</span>
                    <Input.TextArea rows={7} value={draft.prompt} onChange={(event) => patch({ prompt: event.target.value })} placeholder="输入可直接使用的提示词" />
                </label>
                <label>
                    <span className="mb-1.5 block text-sm font-medium">说明（可选）</span>
                    <Input.TextArea rows={2} value={draft.description} onChange={(event) => patch({ description: event.target.value })} />
                </label>
                <div className="grid gap-4 sm:grid-cols-2">
                    <label>
                        <span className="mb-1.5 block text-sm font-medium">封面 URL（可选）</span>
                        <Input value={draft.coverUrl} onChange={(event) => patch({ coverUrl: event.target.value })} placeholder="https://..." />
                    </label>
                    <label>
                        <span className="mb-1.5 block text-sm font-medium">标签（可选）</span>
                        <Input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="商品, 摄影" />
                    </label>
                </div>
                <label>
                    <span className="mb-1.5 block text-sm font-medium">参考图 URL（可选，每行一个）</span>
                    <Input.TextArea rows={3} value={referenceImages} onChange={(event) => setReferenceImages(event.target.value)} placeholder={"https://...\nhttps://..."} />
                </label>
            </div>
        </Modal>
    );
}

function toInput(prompt: PersonalPrompt): PersonalPromptInput {
    return {
        title: prompt.title,
        prompt: prompt.prompt,
        description: prompt.description,
        coverUrl: prompt.coverUrl,
        referenceImageUrls: prompt.referenceImageUrls,
        tags: prompt.tags,
        imageMode: prompt.imageMode,
        imageModel: prompt.imageModel,
        imageSize: prompt.imageSize,
        imageCount: prompt.imageCount,
    };
}

function splitValues(value: string, separator: RegExp) {
    return Array.from(new Set(value.split(separator).map((item) => item.trim()).filter(Boolean)));
}
