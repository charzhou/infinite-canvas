import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { canvasThemes } from "@/lib/canvas-theme";
import { defaultConfig, type AiConfig } from "@/stores/use-config-store";
import { VideoSettingsPanel } from "./video-settings-panel";

afterEach(cleanup);

const config: AiConfig = {
    ...defaultConfig,
    model: "compute::seedance-2.5",
    videoModel: "compute::grok-imagine-video",
    videoSeconds: "30",
    channels: [{
        id: "compute", name: "算力", baseUrl: "https://example.com", apiKey: "test", apiFormat: "openai",
        models: [
            { name: "seedance-2.5", capability: "video" },
            { name: "grok-imagine-video", capability: "video", apiFormat: "xai" },
        ],
    }],
};

it("follows the selected model when it differs from the global video default and changes", () => {
    const onConfigChange = vi.fn();
    const { rerender } = render(<VideoSettingsPanel config={config} theme={canvasThemes.light} onConfigChange={onConfigChange} />);
    expect(screen.getByRole("button", { name: "全能参考模式" })).toBeInTheDocument();
    expect(screen.getByRole("slider")).toHaveAttribute("aria-valuemax", "30");

    rerender(<VideoSettingsPanel config={{ ...config, model: config.videoModel, videoModel: config.model }} theme={canvasThemes.light} onConfigChange={onConfigChange} />);
    expect(screen.getByRole("button", { name: "多图参考" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "全能参考模式" })).not.toBeInTheDocument();
    expect(screen.getByRole("slider")).toHaveAttribute("aria-valuemax", "15");
    expect(screen.getByRole("slider")).toHaveAttribute("aria-valuenow", "15");
    expect(onConfigChange).not.toHaveBeenCalled();
});
