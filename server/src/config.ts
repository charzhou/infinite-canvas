export type OidcModel = {
    scope: string;
    platform: "openai" | "grok";
    name: string;
    apiFormat: "openai" | "xai";
    capability: "image" | "video" | "text";
};

export type OidcConfig = {
    issuer: URL;
    clientId: string;
    clientSecret: string;
    sessionKey: Uint8Array;
    providerName: string;
    publicOrigin: URL;
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

const approvedScopes = new Set(["openid", ...approvedModels.map((model) => model.scope)]);

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

export function parseScopes(value: string) {
    const values = value.trim().split(/\s+/).filter(Boolean);
    if (values.filter((scope) => scope === "openid").length !== 1) {
        throw new Error("OIDC_REQUESTED_SCOPES 必须且只能包含一个 openid");
    }
    const scopes = [...new Set(values)];
    if (scopes.some((scope) => scope === "llm" || !approvedScopes.has(scope))) {
        throw new Error("OIDC_REQUESTED_SCOPES 包含不受支持的 scope");
    }
    if (scopes.length !== approvedScopes.size || scopes.some((scope) => !approvedScopes.has(scope))) {
        throw new Error("OIDC_REQUESTED_SCOPES 必须包含当前批准的全部模型 scope");
    }
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
    return {
        issuer: normalizedOrigin(env.OIDC_ISSUER!, "OIDC_ISSUER"),
        clientId: env.OIDC_CLIENT_ID!.trim(),
        clientSecret: env.OIDC_CLIENT_SECRET!,
        sessionKey,
        providerName: env.OIDC_PROVIDER_NAME?.trim() || "Provider",
        publicOrigin: normalizedOrigin(env.PUBLIC_ORIGIN!, "PUBLIC_ORIGIN"),
        scopes,
        models: scopeModels(scopes),
    };
}
