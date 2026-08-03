import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";

import { isSub2ApiChannelLinkPath } from "@/lib/sub2api-channel-link-bootstrap";

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

it.each(["/connect/sub2api", "/connect/sub2api/", "/CONNECT/Sub2API"])("clears Sub2API credentials before analytics initialization on %s", async (pathname) => {
    window.history.replaceState(null, "", `${pathname}?apiKey=sk-test&channel=descriptor&next=1`);

    await import("./main");

    expect(analytics.init).toHaveBeenCalledOnce();
    expect(analytics.observedSearch).toBe("?next=1");
    expect(window.location.search).toBe("?next=1");
});

it.each(["/connect/sub2api-extra", "/connect/sub2api/child", "/other/connect/sub2api"])("does not recognize an unrelated path: %s", (pathname) => {
    expect(isSub2ApiChannelLinkPath(pathname)).toBe(false);
});
