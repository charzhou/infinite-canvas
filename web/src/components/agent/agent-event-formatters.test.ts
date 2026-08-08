import { expect, it } from "vitest";

import { agentMessageId, reconcileLiveAgentTurns, registerLiveAgentTurn } from "./agent-event-formatters";

it("scopes message identities by thread, turn, and item", () => {
    expect(new Set([
        agentMessageId("thread-1", "turn-1", "item-1"),
        agentMessageId("thread-2", "turn-1", "item-1"),
        agentMessageId("thread-1", "turn-2", "item-1"),
        agentMessageId("thread-1", "turn-1", "item-2"),
    ]).size).toBe(4);
});

it("rejects late live messages once the turn history is authoritative", () => {
    const key = "thread-1\0turn-1";
    const liveTurns = new Set<string>();

    expect(registerLiveAgentTurn({ threadId: "thread-1", turnId: "turn-1" }, new Set([key]), liveTurns)).toBe(false);
    expect(registerLiveAgentTurn({ threadId: "thread-1", turnId: "turn-1", replayed: true }, new Set([key]), liveTurns)).toBe(false);
    expect(liveTurns.has(key)).toBe(false);
});

it("keeps usage updates without reviving an authoritative turn", () => {
    const key = "thread-1\0turn-1";
    const liveTurns = new Set<string>();

    expect(registerLiveAgentTurn({ type: "usage.updated", threadId: "thread-1", turnId: "turn-1" }, new Set([key]), liveTurns)).toBe(true);
    expect(liveTurns.has(key)).toBe(false);
});

it("does not revive an authoritative active turn while reconciling a snapshot", () => {
    const settledKey = "thread-1\0turn-1";
    const otherLiveKey = "thread-1\0turn-2";
    const liveTurns = new Set([settledKey, otherLiveKey]);

    reconcileLiveAgentTurns("thread-1", "turn-1", new Set([settledKey]), liveTurns);

    expect(liveTurns.has(settledKey)).toBe(false);
    expect(liveTurns.has(otherLiveKey)).toBe(true);
});
