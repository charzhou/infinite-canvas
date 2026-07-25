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
    scope: string;
};

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

export async function exchangeCode(config: OidcConfig, discovery: Discovery, code: string): Promise<TokenResponse> {
    const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: new URL("/api/oidc/callback", config.publicOrigin).toString(),
    });
    const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
    const response = await fetch(discovery.token_endpoint, {
        method: "POST",
        headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/x-www-form-urlencoded" },
        body,
    });
    const payload = (await response.json().catch(() => null)) as { access_token?: unknown; id_token?: unknown; scope?: unknown } | null;
    if (!response.ok || !payload || typeof payload.access_token !== "string" || typeof payload.id_token !== "string" || typeof payload.scope !== "string") {
        throw new Error("OIDC 授权码交换失败");
    }
    return { accessToken: payload.access_token, idToken: payload.id_token, scope: payload.scope };
}

export async function verifyIdToken(config: OidcConfig, discovery: Discovery, idToken: string, nonce: string) {
    const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
    const { payload } = await jwtVerify(idToken, jwks, { issuer: config.issuer.origin, audience: config.clientId, algorithms: ["RS256"] });
    if (payload.nonce !== nonce || typeof payload.sub !== "string" || !payload.sub) throw new Error("OIDC ID Token 无效");
    return payload.sub;
}

export async function revokeAccessToken(config: OidcConfig, discovery: Discovery, accessToken: string) {
    const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
    await fetch(discovery.revocation_endpoint, {
        method: "POST",
        headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: accessToken, token_type_hint: "access_token" }),
    });
}
