export type OidcModel = {
    scope: string;
    platform: "openai" | "grok";
    name: string;
    apiFormat: "openai" | "xai";
    capability: "image" | "video" | "text";
};

export type OidcConfig = {
    issuer: URL;
    gatewayBaseUrl: URL;
    clientId: string;
    clientSecret: string;
    sessionKey: Uint8Array;
    providerName: string;
    publicOrigin: URL;
    proxyTimeoutMs: number;
    scopes: string[];
    models: OidcModel[];
};

const approvedModels: OidcModel[] = [
    { scope: "llm:grok:grok-imagine-image", platform: "grok", name: "grok-imagine-image", apiFormat: "xai", capability: "image" },
    { scope: "llm:grok:grok-imagine-image-quality", platform: "grok", name: "grok-imagine-image-quality", apiFormat: "xai", capability: "image" },
    { scope: "llm:grok:grok-imagine-video", platform: "grok", name: "grok-imagine-video", apiFormat: "xai", capability: "video" },
    { scope: "llm:grok:grok-imagine-video-1.5", platform: "grok", name: "grok-imagine-video-1.5", apiFormat: "xai", capability: "video" },
    { scope: "llm:openai:gpt-image-2", platform: "openai", name: "gpt-image-2", apiFormat: "openai", capability: "image" },
    { scope: "llm:openai:gpt-5.6-terra", platform: "openai", name: "gpt-5.6-terra", apiFormat: "openai", capability: "text" },
];

const standardScopes = new Set(["openid", "profile", "email", "offline_access"]);
const approvedScopes = new Set([...standardScopes, ...approvedModels.map((model) => model.scope)]);
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
    if (new Set(values).size !== values.length) throw new Error("OIDC_REQUESTED_SCOPES 不能包含重复 scope");
    if (!values.includes("openid")) throw new Error("OIDC_REQUESTED_SCOPES 必须包含 openid");
    if (!values.includes("offline_access")) throw new Error("OIDC_REQUESTED_SCOPES 必须包含 offline_access");
    const scopes = values;
    if (scopes.some((scope) => scope === "llm" || !approvedScopes.has(scope))) {
        throw new Error("OIDC_REQUESTED_SCOPES 包含不受支持的 scope");
    }
    if (!scopes.some((scope) => scope.startsWith("llm:"))) throw new Error("OIDC_REQUESTED_SCOPES 必须包含至少一个模型 scope");
    return scopes;
}

export function scopeModels(scopes: string[]) {
    const enabledScopes = new Set(scopes);
    return approvedModels.filter((model) => enabledScopes.has(model.scope));
}

export function loadOidcConfig(env = process.env): OidcConfig | null {
    const required = ["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_SESSION_KEY", "PUBLIC_ORIGIN", "OIDC_REQUESTED_SCOPES"] as const;
    if (required.some((key) => !env[key]?.trim())) return null;

    const sessionKey = Buffer.from(env.OIDC_SESSION_KEY!, "base64url");
    if (sessionKey.byteLength !== 32) throw new Error("OIDC_SESSION_KEY 必须是 base64url 编码的 32 字节密钥");

    const scopes = parseScopes(env.OIDC_REQUESTED_SCOPES!);
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
        scopes,
        models: scopeModels(scopes),
    };
}
