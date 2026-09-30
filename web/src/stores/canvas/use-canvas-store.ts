import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import i18n from "@/i18n";
import { strictLocalForageStorage } from "@/lib/localforage-storage";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";

export type CanvasProject = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
};

export type CanvasDeletedProject = {
    id: string;
    deletedAt: string;
};

type CanvasStore = {
    hydrated: boolean;
    hydrationError: string | null;
    projects: CanvasProject[];
    deletedProjects: CanvasDeletedProject[];
    createProject: (title?: string) => string;
    importProject: (project: Partial<CanvasProject>) => string;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => void;
    deleteProjects: (ids: string[]) => void;
    replaceProjects: (projects: CanvasProject[], deletedProjects?: CanvasDeletedProject[]) => void;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport">>) => void;
};

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
const CANVAS_STORE_KEY = "infinite-canvas:canvas_store";
type PersistedCanvasState = Pick<CanvasStore, "projects" | "deletedProjects">;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let queuedPersistState: PersistedCanvasState | null = null;
let queuedPersistValue: { name: string; value: string } | null = null;
let hydrationFailed = false;

const getStorageErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

function recordTime(value: string | undefined) {
    return value ? Date.parse(value) || 0 : 0;
}

function mergeCanvasState(value: StorageValue<CanvasStore>, stored?: StorageValue<CanvasStore> | null) {
    if (!stored) return value;
    const projects = new Map((stored.state.projects || []).map((project) => [project.id, project]));
    value.state.projects.forEach((project) => {
        const previous = projects.get(project.id);
        if (!previous || recordTime(project.updatedAt) >= recordTime(previous.updatedAt)) projects.set(project.id, project);
    });
    const deleted = new Map((stored.state.deletedProjects || []).map((project) => [project.id, project]));
    value.state.deletedProjects.forEach((project) => {
        const previous = deleted.get(project.id);
        if (!previous || recordTime(project.deletedAt) >= recordTime(previous.deletedAt)) deleted.set(project.id, project);
    });
    const deletedProjects = [...deleted.values()];
    const activeProjects = [...projects.values()].filter((project) => {
        const tombstone = deleted.get(project.id);
        return !tombstone || recordTime(project.updatedAt) > recordTime(tombstone.deletedAt);
    });
    return { ...value, state: { ...value.state, projects: activeProjects, deletedProjects } };
}

async function persistCanvasValue(name: string, value: string) {
    const parsed = JSON.parse(value) as StorageValue<CanvasStore>;
    const stored = await strictLocalForageStorage.getItem(name);
    const merged = mergeCanvasState(parsed, stored ? (JSON.parse(stored) as StorageValue<CanvasStore>) : null);
    await strictLocalForageStorage.setItem(name, JSON.stringify(merged));
}

const flushCanvasPersist = () => {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    const pending = queuedPersistValue;
    queuedPersistState = null;
    queuedPersistValue = null;
    if (!pending || hydrationFailed) return;
    void persistCanvasValue(pending.name, pending.value).catch((error) => {
        hydrationFailed = true;
        useCanvasStore.setState({ hydrated: true, hydrationError: getStorageErrorMessage(error) });
    });
};

if (typeof window !== "undefined") {
    window.addEventListener("pagehide", flushCanvasPersist);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flushCanvasPersist();
    });
}

const canvasStorage: PersistStorage<CanvasStore> = {
    getItem: async (name) => {
        const value = await strictLocalForageStorage.getItem(name);
        if (!value) return null;
        const parsed = JSON.parse(value) as StorageValue<CanvasStore>;
        queuedPersistState = parsed.state as PersistedCanvasState;
        return parsed;
    },
    setItem: (name, value) => {
        if (hydrationFailed) return Promise.resolve();
        const nextState = value.state as PersistedCanvasState;
        if (queuedPersistState && queuedPersistState.projects === nextState.projects && queuedPersistState.deletedProjects === nextState.deletedProjects) return Promise.resolve();
        queuedPersistState = nextState;
        queuedPersistValue = { name, value: JSON.stringify(value) };
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            flushCanvasPersist();
        }, 400);
        return Promise.resolve();
    },
    removeItem: (name) => strictLocalForageStorage.removeItem(name),
};

export const useCanvasStore = create<CanvasStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            hydrationError: null,
            projects: [],
            deletedProjects: [],
            createProject: (title = i18n.t("canvas.project.untitled")) => {
                if (hydrationFailed) return "";
                const now = new Date().toISOString();
                const id = nanoid();
                const project: CanvasProject = {
                    id,
                    title,
                    createdAt: now,
                    updatedAt: now,
                    nodes: [],
                    connections: [],
                    chatSessions: [],
                    activeChatId: null,
                    backgroundMode: "lines",
                    showImageInfo: false,
                    viewport: initialViewport,
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                return id;
            },
            importProject: (source) => {
                if (hydrationFailed) return "";
                const now = new Date().toISOString();
                const project: CanvasProject = {
                    id: nanoid(),
                    title: source.title || i18n.t("canvas.project.imported"),
                    createdAt: source.createdAt || now,
                    updatedAt: now,
                    nodes: source.nodes || [],
                    connections: source.connections || [],
                    chatSessions: source.chatSessions || [],
                    activeChatId: source.activeChatId || null,
                    backgroundMode: source.backgroundMode || "lines",
                    showImageInfo: source.showImageInfo || false,
                    viewport: source.viewport || initialViewport,
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                return project.id;
            },
            openProject: (id) => {
                return get().projects.find((item) => item.id === id) || null;
            },
            renameProject: (id, title) => {
                if (hydrationFailed) return;
                set((state) => ({
                    projects: state.projects.map((project) => (project.id === id ? { ...project, title: title.trim() || project.title, updatedAt: new Date().toISOString() } : project)),
                }));
            },
            deleteProjects: (ids) => {
                if (hydrationFailed) return;
                set((state) => {
                    const now = new Date().toISOString();
                    const removing = new Set(ids);
                    const projects = state.projects.filter((project) => !removing.has(project.id));
                    const deletedProjects = [...state.deletedProjects.filter((item) => !removing.has(item.id)), ...ids.map((id) => ({ id, deletedAt: now }))];
                    return { projects, deletedProjects };
                });
            },
            replaceProjects: (projects, deletedProjects = []) => {
                if (hydrationFailed) return;
                set({ projects, deletedProjects });
            },
            updateProject: (id, patch) => {
                if (hydrationFailed) return;
                set((state) => ({
                    projects: state.projects.map((project) => (project.id === id ? { ...project, ...patch, updatedAt: new Date().toISOString() } : project)),
                }));
            },
        }),
        {
            name: CANVAS_STORE_KEY,
            storage: canvasStorage,
            partialize: (state) =>
                ({
                    projects: state.projects,
                    deletedProjects: state.deletedProjects,
                }) as StorageValue<CanvasStore>["state"],
            onRehydrateStorage: () => (_state, error) => {
                if (error) {
                    hydrationFailed = true;
                    useCanvasStore.setState({ hydrated: true, hydrationError: getStorageErrorMessage(error) });
                    return;
                }
                useCanvasStore.setState({ hydrated: true, hydrationError: null });
            },
        },
    ),
);
