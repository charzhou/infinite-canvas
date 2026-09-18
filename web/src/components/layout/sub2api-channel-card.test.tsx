import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "antd";
import { beforeEach, expect, it, vi } from "vitest";

import { fetchChannelModels } from "@/services/api/image";
import { defaultConfig, useConfigStore } from "@/stores/use-config-store";
import { useOidcStore } from "@/stores/use-oidc-store";
import { Sub2ApiChannelCard } from "./sub2api-channel-card";

vi.mock("@/services/api/image", () => ({ fetchChannelModels: vi.fn() }));

beforeEach(() => {
    vi.mocked(fetchChannelModels).mockReset();
    useConfigStore.setState({ config: structuredClone(defaultConfig) });
    useOidcStore.setState({ enabled: false, providerName: "", connected: false, modelIds: [], loading: false, error: "" });
});

function renderCard() {
    return render(<App><Sub2ApiChannelCard /></App>);
}

it("keeps both Sub2API connection modes visible when OIDC is unavailable", () => {
    renderCard();
    expect(screen.getByRole("button", { name: "授权连接" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "使用 API Key" })).toBeInTheDocument();
});

it("verifies a long-lived API Key before saving the singleton channel", async () => {
    vi.mocked(fetchChannelModels).mockResolvedValue(["grok-imagine-video", "seedance-2.5"]);
    renderCard();

    fireEvent.click(screen.getByRole("button", { name: "使用 API Key" }));
    fireEvent.change(screen.getByPlaceholderText("输入长期有效的 API Key"), { target: { value: "sk-test" } });
    fireEvent.click(screen.getByRole("button", { name: "验证并读取模型" }));

    await screen.findByText("grok-imagine-video");
    expect(document.body.textContent).not.toContain("sk-test");
    fireEvent.click(screen.getByRole("button", { name: "保存并连接" }));

    await waitFor(() => expect(useConfigStore.getState().config.channels.find((channel) => channel.id === "sub2api")).toMatchObject({ authMode: "manual", providerId: "sub2api", apiKey: "sk-test" }));
    expect(useConfigStore.getState().config.channels.find((channel) => channel.id === "sub2api")?.models).toEqual([
        { name: "grok-imagine-video", capability: "video", apiFormat: "xai" },
        { name: "seedance-2.5", capability: "video", apiFormat: "openai" },
    ]);
});
