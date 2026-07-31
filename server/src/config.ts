export type OidcModel = {
    id: string;
    platform: "openai" | "grok";
    name: string;
    apiFormat: "openai" | "xai";
    capability: "image" | "video" | "text";
};

type OidcCatalogModel = OidcModel & { scope: string };

export type OidcConfig = {
    issuer: URL;
    gatewayBaseUrl: URL;
    clientId: string;
    clientSecret: string;
    sessionKey: Uint8Array;
    providerName: string;
    publicOrigin: URL;
    proxyTimeoutMs: number;
};

const oidcModelCatalog: OidcCatalogModel[] = [
    { id: "grok/grok-imagine-image", scope: "llm:grok:grok-imagine-image", platform: "grok", name: "grok-imagine-image", apiFormat: "xai", capability: "image" },
    { id: "grok/grok-imagine-image-quality", scope: "llm:grok:grok-imagine-image-quality", platform: "grok", name: "grok-imagine-image-quality", apiFormat: "xai", capability: "image" },
    { id: "grok/grok-imagine-video", scope: "llm:grok:grok-imagine-video", platform: "grok", name: "grok-imagine-video", apiFormat: "xai", capability: "video" },
    { id: "grok/grok-imagine-video-1.5", scope: "llm:grok:grok-imagine-video-1.5", platform: "grok", name: "grok-imagine-video-1.5", apiFormat: "xai", capability: "video" },
    { id: "openai/gpt-image-2", scope: "llm:openai:gpt-image-2", platform: "openai", name: "gpt-image-2", apiFormat: "openai", capability: "image" },
    { id: "openai/seedance-2-0", scope: "llm:openai:seedance-2-0", platform: "openai", name: "seedance-2-0", apiFormat: "openai", capability: "video" },
    { id: "openai/seedance-2-0-mini", scope: "llm:openai:seedance-2-0-mini", platform: "openai", name: "seedance-2-0-mini", apiFormat: "openai", capability: "video" },
    { id: "openai/seedance-2-0-fast", scope: "llm:openai:seedance-2-0-fast", platform: "openai", name: "seedance-2-0-fast", apiFormat: "openai", capability: "video" },
    { id: "openai/gpt-5.6-terra", scope: "llm:openai:gpt-5.6-terra", platform: "openai", name: "gpt-5.6-terra", apiFormat: "openai", capability: "text" },
];

const standardScopes = new Set(["openid", "profile", "email", "offline_access"]);
const catalogScopes = new Set(oidcModelCatalog.map((model) => model.scope));
const defaultProxyTimeoutMs = 600_000;

function normalizedOrigin(value: string, name: string) {
    let url: URL;
    try {
        url = new URL(value.trim());
    } catch {
        throw new Error(`${name} 必须是有效的 HTTP(S) Origin`);
    }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
        throw new Error(`${name} 必须是有效的 HTTP(S) Origin`);
    }
    return new URL(url.origin);
}

function proxyTimeout(value: string | undefined) {
    if (!value?.trim()) return defaultProxyTimeoutMs;
    const timeout = Number(value);
    if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error("OIDC_PROXY_TIMEOUT_MS 必须是正整数毫秒数");
    return timeout;
}

export function parseScopes(value: string) {
    const values = value.trim().split(/\s+/).filter(Boolean);
    if (new Set(values).size !== values.length) throw new Error("OIDC scope 不能包含重复值");
    if (!values.includes("openid") || !values.includes("offline_access")) throw new Error("OIDC scope 必须包含 openid 与 offline_access");
    if (values.some((scope) => !standardScopes.has(scope) && !catalogScopes.has(scope))) {
        throw new Error("OIDC scope 包含目录外模型");
    }
    if (!values.some((scope) => catalogScopes.has(scope))) throw new Error("OIDC scope 必须包含至少一个模型");
    return values;
}

export function modelCatalog() {
    return oidcModelCatalog.map(({ scope: _scope, ...model }) => model);
}

export function scopesForModelIds(value: unknown) {
    if (!Array.isArray(value) || !value.length || value.some((id) => typeof id !== "string")) throw new Error("必须选择至少一个 OIDC 模型");
    const ids = value.map((id) => id.trim());
    if (new Set(ids).size !== ids.length) throw new Error("OIDC 模型不能重复");
    const selected = ids.map((id) => oidcModelCatalog.find((model) => model.id === id));
    if (selected.some((model) => !model)) throw new Error("OIDC 模型不在目录中");
    return ["openid", "offline_access", ...selected.map((model) => model!.scope)];
}

export function scopeModels(scopes: string[]) {
    const enabledScopes = new Set(scopes);
    return oidcModelCatalog.filter((model) => enabledScopes.has(model.scope)).map(({ scope: _scope, ...model }) => model);
}

export function loadOidcConfig(env = process.env): OidcConfig | null {
    const required = ["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_SESSION_KEY", "PUBLIC_ORIGIN"] as const;
    if (required.some((key) => !env[key]?.trim())) return null;

    const sessionKey = Buffer.from(env.OIDC_SESSION_KEY!, "base64url");
    if (sessionKey.byteLength !== 32) throw new Error("OIDC_SESSION_KEY 必须是 base64url 编码的 32 字节密钥");

    const issuer = normalizedOrigin(env.OIDC_ISSUER!, "OIDC_ISSUER");
    const gatewayBaseUrl = env.OIDC_GATEWAY_BASE_URL?.trim()
        ? normalizedOrigin(env.OIDC_GATEWAY_BASE_URL, "OIDC_GATEWAY_BASE_URL")
        : issuer;
    return {
        issuer,
        gatewayBaseUrl,
        clientId: env.OIDC_CLIENT_ID!.trim(),
        clientSecret: env.OIDC_CLIENT_SECRET!,
        sessionKey,
        providerName: env.OIDC_PROVIDER_NAME?.trim() || "Provider",
        publicOrigin: normalizedOrigin(env.PUBLIC_ORIGIN!, "PUBLIC_ORIGIN"),
        proxyTimeoutMs: proxyTimeout(env.OIDC_PROXY_TIMEOUT_MS),
    };
}
