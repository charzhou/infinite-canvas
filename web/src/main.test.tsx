import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";

const analytics = vi.hoisted(() => ({ observedSearch: "", init: vi.fn() }));
const root = vi.hoisted(() => ({ render: vi.fn() }));

vi.mock("react-dom/client", () => ({ createRoot: vi.fn(() => root) }));
vi.mock("@/components/layout/app-providers", () => ({ AppProviders: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/router", () => ({ router: {} }));
vi.mock("@/lib/analytics", () => ({
    initAnalytics: () => {
        analytics.observedSearch = window.location.search;
        analytics.init();
    },
}));

beforeEach(() => {
    vi.resetModules();
    analytics.observedSearch = "";
    analytics.init.mockClear();
    root.render.mockClear();
    document.body.innerHTML = '<div id="root"></div>';
});

it("clears Sub2API credentials before analytics initialization", async () => {
    window.history.replaceState(null, "", "/connect/sub2api?apiKey=sk-test&channel=descriptor&next=1");

    await import("./main");

    expect(analytics.init).toHaveBeenCalledOnce();
    expect(analytics.observedSearch).toBe("?next=1");
    expect(window.location.search).toBe("?next=1");
});
