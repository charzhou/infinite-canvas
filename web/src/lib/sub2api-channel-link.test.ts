import { describe, expect, it } from "vitest";
import { clearSub2ApiChannelLink, readSub2ApiChannelLink, resolveSub2ApiChannelModels } from "./sub2api-channel-link";

const descriptor = { channelId: "tenant-a", name: "Tenant A", models: [{ name: "grok-imagine-video", capability: "video" as const, apiFormat: "xai" as const }], defaults: { video: "grok-imagine-video" } };
const channel = btoa(JSON.stringify(descriptor)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("Sub2API 渠道链接", () => {
    it("reads the key and a base64url descriptor, then removes both parameters", () => {
        expect(readSub2ApiChannelLink(`?apiKey=sk-test&channel=${channel}`)).toEqual({ apiKey: "sk-test", descriptor });
        expect(clearSub2ApiChannelLink(`?apiKey=sk-test&channel=${channel}&next=1`)).toBe("?next=1");
    });

    it("keeps only models granted by /v1/models and preserves declared xAI metadata", () => {
        expect(resolveSub2ApiChannelModels(["gpt-5.6-terra", "grok-imagine-video"], descriptor)).toEqual([
            { name: "grok-imagine-video", capability: "video", apiFormat: "xai" },
        ]);
    });

    it.each(["?apiKey=&channel=x", "?apiKey=sk-test", "?apiKey=sk-test&channel=not-base64"])("rejects an invalid link: %s", (search) => {
        expect(() => readSub2ApiChannelLink(search)).toThrow("Sub2API 授权链接无效");
    });

    it("trims declared names and rejects fields outside the descriptor schema", () => {
        const trimmed = btoa(JSON.stringify({ channelId: "tenant-a", name: " Tenant A ", models: [{ name: " grok-imagine-video ", capability: "video" }] })).replace(/=+$/, "");
        const unsafe = btoa(JSON.stringify({ channelId: "tenant-a", baseUrl: "https://example.com" })).replace(/=+$/, "");
        expect(readSub2ApiChannelLink(`?apiKey=sk-test&channel=${trimmed}`).descriptor).toMatchObject({ name: "Tenant A", models: [{ name: "grok-imagine-video" }] });
        expect(() => readSub2ApiChannelLink(`?apiKey=sk-test&channel=${unsafe}`)).toThrow("Sub2API 授权链接无效");
    });

    it("rejects a default model not granted to the API Key", () => {
        expect(() => resolveSub2ApiChannelModels(["gpt-5.6-terra"], { channelId: "tenant-a", defaults: { video: "grok-imagine-video" } })).toThrow("默认模型不可用");
    });
});
