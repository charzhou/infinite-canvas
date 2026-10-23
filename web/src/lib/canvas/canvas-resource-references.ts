import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import i18n from "@/i18n";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { getDataUrlByteSize, readImageMeta } from "@/lib/image-utils";
import { imageToDataUrl } from "@/services/image-storage";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

export type CanvasResourceKind = "image" | "video" | "audio" | "text";

export type CanvasResourceReference = {
    id: string;
    nodeId: string;
    kind: CanvasResourceKind;
    label: string;
    title: string;
    previewUrl?: string;
    text?: string;
    active: boolean;
};

export type CanvasResourceIndex = {
    nodeById: Map<string, CanvasNodeData>;
    incomingByNodeId: Map<string, CanvasNodeData[]>;
    configTargetByNodeId: Map<string, string>;
    groupResourcesById: Map<string, CanvasNodeData[]>;
    configInputsByNodeId: Map<string, CanvasNodeData[]>;
};

export function createCanvasResourceIndex(nodes: CanvasNodeData[], connections: CanvasConnection[]): CanvasResourceIndex {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const resourceIds = new Set<string>();
    const groupResourcesById = new Map<string, CanvasNodeData[]>();
    nodes.forEach((node) => {
        if (!isResourceNode(node)) return;
        resourceIds.add(node.id);
        const groupId = node.metadata?.groupId;
        if (!groupId) return;
        const children = groupResourcesById.get(groupId);
        if (children) children.push(node);
        else groupResourcesById.set(groupId, [node]);
    });
    const incomingByNodeId = new Map<string, CanvasNodeData[]>();
    const configTargetByNodeId = new Map<string, string>();
    connections.forEach((connection) => {
        const source = nodeById.get(connection.fromNodeId);
        if (source && (resourceIds.has(source.id) || (source.type === CanvasNodeType.Group && groupResourcesById.has(source.id)))) {
            const inputs = incomingByNodeId.get(connection.toNodeId);
            if (inputs) inputs.push(source);
            else incomingByNodeId.set(connection.toNodeId, [source]);
        }
        if (!configTargetByNodeId.has(connection.fromNodeId) && nodeById.get(connection.toNodeId)?.type === CanvasNodeType.Config) {
            configTargetByNodeId.set(connection.fromNodeId, connection.toNodeId);
        }
    });
    return { nodeById, incomingByNodeId, configTargetByNodeId, groupResourcesById, configInputsByNodeId: new Map() };
}

export function buildNodeMentionReferences(node: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[], index?: CanvasResourceIndex) {
    return labelResourceNodes(getMentionResourceNodes(node.id, nodes, connections, index), true);
}

export function buildCanvasResourceReferences(nodes: CanvasNodeData[]) {
    return labelResourceNodes(nodes, true);
}

export async function resolveCanvasReferenceImages(references: CanvasResourceReference[], nodes: CanvasNodeData[]) {
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    return Promise.all(references.filter((reference) => reference.kind === "image").map(async (reference) => {
        const node = nodesById.get(reference.nodeId);
        if (!node) throw new Error(i18n.t("agent.composer.mentions.resourceMissing", { title: reference.title }));
        const metadata = node.metadata;
        const dataUrl = await imageToDataUrl({ storageKey: metadata?.storageKey, url: reference.previewUrl });
        if (!dataUrl.startsWith("data:image/")) throw new Error(i18n.t("agent.composer.mentions.imageReadFailed", { title: reference.title }));
        const meta = metadata?.naturalWidth && metadata.naturalHeight
            ? { width: metadata.naturalWidth, height: metadata.naturalHeight, mimeType: metadata.mimeType || dataUrl.match(/^data:([^;]+)/)?.[1] || "image/png" }
            : await readImageMeta(dataUrl);
        return {
            id: `canvas:${node.id}`,
            name: reference.title,
            type: metadata?.mimeType || meta.mimeType,
            size: metadata?.bytes || getDataUrlByteSize(dataUrl),
            width: meta.width,
            height: meta.height,
            url: reference.previewUrl || dataUrl,
            dataUrl,
        };
    }));
}

export function getMentionResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[], index = createCanvasResourceIndex(nodes, connections)) {
    const configInputs = expandGroupResourceNodes(getConnectedConfigInputNodes(nodeId, index), nodes, index);
    if (configInputs.length) return configInputs;
    const ownInputs = expandGroupResourceNodes(index.incomingByNodeId.get(nodeId) || [], nodes, index);
    if (ownInputs.length) return ownInputs;
    const node = index.nodeById.get(nodeId);
    return node && isResourceNode(node) ? [node] : [];
}

export function getGenerationResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[], index = createCanvasResourceIndex(nodes, connections)) {
    const configInputs = getConnectedConfigInputNodes(nodeId, index);
    if (configInputs.length) return configInputs;
    return index.incomingByNodeId.get(nodeId) || [];
}

function getConnectedConfigInputNodes(nodeId: string, index: CanvasResourceIndex) {
    const cached = index.configInputsByNodeId.get(nodeId);
    if (cached) return cached;
    const configId = index.configTargetByNodeId.get(nodeId);
    const inputs = configId ? (index.incomingByNodeId.get(configId) || []).filter((node) => node.id !== nodeId) : [];
    index.configInputsByNodeId.set(nodeId, inputs);
    return inputs;
}

export function isCanvasReferenceNode(node: CanvasNodeData, nodes: CanvasNodeData[], index?: CanvasResourceIndex) {
    return isResourceNode(node) || (node.type === CanvasNodeType.Group && getGroupResourceNodes(node.id, nodes, index).length > 0);
}

function expandGroupResourceNodes(inputNodes: CanvasNodeData[], nodes: CanvasNodeData[], index: CanvasResourceIndex) {
    const resources = inputNodes.flatMap((node) => (node.type === CanvasNodeType.Group ? getGroupResourceNodes(node.id, nodes, index) : [node]));
    return [...new Map(resources.map((node) => [node.id, node])).values()];
}

export function getGroupResourceNodes(groupId: string, nodes: CanvasNodeData[], index?: CanvasResourceIndex) {
    if (index) return index.groupResourcesById.get(groupId) || [];
    return nodes.filter((node) => node.metadata?.groupId === groupId && isResourceNode(node));
}

function labelResourceNodes(nodes: CanvasNodeData[], active: boolean) {
    const counts: Record<CanvasResourceKind, number> = { image: 0, video: 0, audio: 0, text: 0 };
    return nodes.flatMap((node): CanvasResourceReference[] => {
        const kind = resourceKind(node);
        if (!kind) return [];
        const resource = getNodeDefinition(node.type)?.resource?.(node);
        const index = counts[kind]++;
        const label = labelForKind(kind, index);
        return [
            {
                id: node.id,
                nodeId: node.id,
                kind,
                label,
                title: node.title || label,
                previewUrl: node.metadata?.content || resource?.url,
                text: resourceText(node),
                active,
            },
        ];
    });
}

function labelForKind(kind: CanvasResourceKind, index: number) {
    if (kind === "image") return imageReferenceLabel(index);
    if (kind === "video") return i18n.t("canvas.configNode.videoReferences") + ` ${index + 1}`;
    if (kind === "audio") return i18n.t("canvas.configNode.audioReferences") + ` ${index + 1}`;
    return i18n.t("canvas.composer.resources.text", { index: index + 1 });
}

function isResourceNode(node: CanvasNodeData) {
    return Boolean(resourceKind(node));
}

function resourceText(node: CanvasNodeData): string | undefined {
    if (node.type === CanvasNodeType.Text) return node.metadata?.content || node.metadata?.prompt;
    const resource = getNodeDefinition(node.type)?.resource?.(node);
    return resource?.kind === "text" ? resource.text : undefined;
}

function resourceKind(node: CanvasNodeData): CanvasResourceKind | null {
    if (node.type === CanvasNodeType.Image && node.metadata?.content) return "image";
    if (node.type === CanvasNodeType.Video && node.metadata?.content) return "video";
    if (node.type === CanvasNodeType.Audio && node.metadata?.content) return "audio";
    if (node.type === CanvasNodeType.Text && (node.metadata?.content || node.metadata?.prompt)) return "text";
    // Plugin nodes declare their input eligibility through definition.resource.
    return getNodeDefinition(node.type)?.resource?.(node)?.kind || null;
}
