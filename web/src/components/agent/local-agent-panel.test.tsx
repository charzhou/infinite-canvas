import { act, render, waitFor } from "@testing-library/react";
import { App } from "antd";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { useAgentStore } from "@/stores/use-agent-store";
import { LocalAgentPanel } from "./local-agent-panel";

class MockEventSource {
    static instances: MockEventSource[] = [];
    readonly listeners = new Map<string, EventListener[]>();
    onerror: ((event: Event) => void) | null = null;

    constructor(_url: string) {
        MockEventSource.instances.push(this);
    }

    addEventListener(type: string, listener: EventListener) {
        this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
    }

    close() {}

    emit(type: string, data: unknown) {
        this.listeners.get(type)?.forEach((listener) => listener({ data: JSON.stringify(data) } as MessageEvent));
    }
}

beforeEach(() => {
    MockEventSource.instances = [];
    HTMLElement.prototype.scrollTo = vi.fn();
    vi.stubGlobal("EventSource", MockEventSource);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/agent/codex/threads")) return new Promise(() => {});
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }));
    useAgentStore.setState({
        url: "http://127.0.0.1:17371",
        token: "token",
        enabled: true,
        connected: false,
        activeThreadId: "thread-1",
        messages: [],
        eventLogs: [],
        waiting: false,
        sending: false,
        pendingTool: null,
        activeTab: "chat",
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
    useAgentStore.setState({ enabled: false, connected: false, messages: [], eventLogs: [], activeThreadId: "", waiting: false, sending: false, pendingTool: null });
});

it("shows an unscoped legacy Agent reply in the active thread", async () => {
    render(
        <MemoryRouter>
            <App>
                <LocalAgentPanel embedded />
            </App>
        </MemoryRouter>,
    );

    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    const source = MockEventSource.instances[0];
    act(() => source.emit("hello", { ok: true, clientId: "client-1" }));
    await waitFor(() => expect(useAgentStore.getState().connected).toBe(true));
    await act(async () => {
        MockEventSource.instances.at(-1)?.emit("agent_event", { type: "item.updated", item: { id: "message-1", type: "agent_message", text: "旧 Agent 的实时回复" } });
        await Promise.resolve();
    });

    await waitFor(() => expect(useAgentStore.getState().messages).toEqual([expect.objectContaining({ role: "assistant", text: "旧 Agent 的实时回复" })]));
});
