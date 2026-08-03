import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";

import { fetchChannelModels } from "@/services/api/image";
import { defaultConfig, useConfigStore } from "@/stores/use-config-store";
import Sub2ApiConnectPage from "./sub2api";

vi.mock("@/services/api/image", () => ({ fetchChannelModels: vi.fn() }));

const validChannel = btoa(JSON.stringify({ channelId: "tenant-a", name: "Tenant A" })).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
const validLink = `/connect/sub2api?apiKey=sk-test&channel=${validChannel}`;

beforeEach(() => {
    vi.mocked(fetchChannelModels).mockReset();
    useConfigStore.setState({ config: structuredClone(defaultConfig) });
    window.history.replaceState(null, "", "/");
});

it("cleans the URL before importing the fetched models and redirects home", async () => {
    window.history.replaceState(null, "", validLink);
    vi.mocked(fetchChannelModels).mockResolvedValue(["gpt-5.6-terra"]);

    render(
        <MemoryRouter initialEntries={[window.location.pathname + window.location.search]}>
            <Sub2ApiConnectPage />
        </MemoryRouter>,
    );

    await waitFor(() => expect(useConfigStore.getState().config.channels.some((channel) => channel.id === "tenant-a")).toBe(true));
    expect(window.location.search).toBe("");
});

it("does not persist a channel when model discovery rejects", async () => {
    window.history.replaceState(null, "", validLink);
    vi.mocked(fetchChannelModels).mockRejectedValue(new Error("读取模型失败"));

    render(
        <MemoryRouter initialEntries={[validLink]}>
            <Sub2ApiConnectPage />
        </MemoryRouter>,
    );

    await screen.findByText("授权失败");
    expect(useConfigStore.getState().config.channels.some((channel) => channel.id === "tenant-a")).toBe(false);
});
