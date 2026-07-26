import { createRemoteJWKSet, jwtVerify } from "jose";

import type { OidcConfig } from "./config.js";

export type Discovery = {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    revocation_endpoint: string;
    jwks_uri: string;
};

export type TokenResponse = {
    accessToken: string;
    idToken: string;
    refreshToken: string;
    expiresIn: number;
    scope: string;
};

export class OidcTokenError extends Error {
    constructor(readonly code: string, message: string) {
        super(message);
    }
}

const discoveryCache = new Map<string, Promise<Discovery>>();

function discoveryUrl(config: OidcConfig) {
    return new URL("/.well-known/openid-configuration", config.issuer);
}

function isDiscovery(value: unknown, config: OidcConfig): value is Discovery {
    if (!value || typeof value !== "object") return false;
    const discovery = value as Partial<Discovery>;
    return discovery.issuer === config.issuer.origin && [discovery.authorization_endpoint, discovery.token_endpoint, discovery.revocation_endpoint, discovery.jwks_uri].every((endpoint) => typeof endpoint === "string" && /^https?:\/\//.test(endpoint));
}

export async function discoveryFor(config: OidcConfig): Promise<Discovery> {
    const key = config.issuer.origin;
    const cached = discoveryCache.get(key);
    if (cached) return cached;
    const request = fetch(discoveryUrl(config)).then(async (response) => {
        const payload = await response.json().catch(() => null);
        if (!response.ok || !isDiscovery(payload, config)) throw new Error("OIDC Discovery 无效");
        return payload;
    });
    discoveryCache.set(key, request);
    try {
        return await request;
    } catch (error) {
        discoveryCache.delete(key);
        throw error;
    }
}

function tokenResponse(payload: unknown, failure: string): TokenResponse {
    if (!payload || typeof payload !== "object") throw new OidcTokenError("server_error", failure);
    const value = payload as Record<string, unknown>;
    const expiresIn = value.expires_in;
    if (
        typeof value.access_token !== "string" || typeof value.id_token !== "string" || typeof value.refresh_token !== "string" ||
        typeof value.scope !== "string" || typeof expiresIn !== "number" || !Number.isSafeInteger(expiresIn) || expiresIn <= 0
    ) throw new OidcTokenError("server_error", failure);
    return { accessToken: value.access_token, idToken: value.id_token, refreshToken: value.refresh_token, expiresIn, scope: value.scope };
}

async function exchangeToken(config: OidcConfig, endpoint: string, body: URLSearchParams, failure: string): Promise<TokenResponse> {
    const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
    const response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/x-www-form-urlencoded" },
        body,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
        const code = payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).error === "string"
            ? (payload as Record<string, string>).error
            : "server_error";
        throw new OidcTokenError(code, failure);
    }
    return tokenResponse(payload, failure);
}

export function exchangeCode(config: OidcConfig, discovery: Discovery, code: string) {
    return exchangeToken(config, discovery.token_endpoint, new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: new URL("/api/oidc/callback", config.publicOrigin).toString(),
    }), "OIDC 授权码交换失败");
}

export function refreshAccessToken(config: OidcConfig, discovery: Discovery, refreshToken: string) {
    return exchangeToken(config, discovery.token_endpoint, new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }), "OIDC 刷新令牌失败");
}

export async function verifyIdToken(config: OidcConfig, discovery: Discovery, idToken: string, nonce?: string) {
    const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
    const { payload } = await jwtVerify(idToken, jwks, { issuer: config.issuer.origin, audience: config.clientId, algorithms: ["RS256"] });
    if ((nonce !== undefined && payload.nonce !== nonce) || typeof payload.sub !== "string" || !payload.sub) throw new Error("OIDC ID Token 无效");
    return payload.sub;
}

export async function revokeRefreshToken(config: OidcConfig, discovery: Discovery, refreshToken: string) {
    const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
    await fetch(discovery.revocation_endpoint, {
        method: "POST",
        headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: refreshToken, token_type_hint: "refresh_token" }),
    });
}
