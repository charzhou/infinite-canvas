import { createHash, randomBytes } from "node:crypto";

import { parse as parseCookie, serialize as serializeCookie } from "cookie";
import express, { type Express, type Request, type Response } from "express";

import { openCookie, sealCookie, sessionCookie, transactionCookie } from "./cookies.js";
import { parseScopes, type OidcConfig } from "./config.js";
import { discoveryFor, exchangeCode, OidcTokenError, refreshAccessToken, revokeRefreshToken, verifyIdToken, type Discovery, type TokenResponse } from "./oidc.js";
import { proxyGatewayRequest, proxyPrefix, type ProxyDependencies } from "./proxy.js";

export type OidcTransaction = {
    state: string;
    nonce: string;
    returnTo: string;
};

export type OidcSessionPayload = {
    accessToken: string;
    refreshToken: string;
    accessTokenExpiresAt: number;
    refreshTokenExpiresAt: number;
    subject: string;
    issuer: string;
    scopes: string[];
    createdAt: string;
};

type OidcClient = {
    discoveryFor: (config: OidcConfig) => Promise<Discovery>;
    exchangeCode: (config: OidcConfig, discovery: Discovery, code: string) => Promise<TokenResponse>;
    refresh: (config: OidcConfig, discovery: Discovery, refreshToken: string) => Promise<TokenResponse>;
    verifyIdToken: (config: OidcConfig, discovery: Discovery, idToken: string, nonce?: string) => Promise<string>;
    revoke: (config: OidcConfig, discovery: Discovery, refreshToken: string) => Promise<void>;
};

export type OidcAppDependencies = {
    oidc?: Partial<OidcClient>;
    proxy?: ProxyDependencies;
};

const defaultOidcClient: OidcClient = {
    discoveryFor,
    exchangeCode,
    refresh: refreshAccessToken,
    verifyIdToken,
    revoke: revokeRefreshToken,
};

const refreshSkewMs = 60_000;
const refreshReplayWindowMs = 5_000;
const maxSessionCookieBytes = 4096;
const refreshInFlight = new Map<string, Promise<OidcSessionPayload | null>>();

function cookieValue(request: Request, name: string) {
    return parseCookie(request.headers.cookie || "")[name];
}

function sameScopes(left: string[], right: string[]) {
    return left.length === right.length && left.every((scope) => right.includes(scope));
}

function safeReturnTo(value: unknown, config: OidcConfig) {
    if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/config";
    try {
        const url = new URL(value, config.publicOrigin);
        if (url.origin !== config.publicOrigin.origin || url.pathname.startsWith("/api/")) return "/config";
        return `${url.pathname}${url.search}${url.hash}`;
    } catch {
        return "/config";
    }
}

function redirectOidcResult(response: Response, returnTo: string | undefined, result: "connected" | "failed", config: OidcConfig) {
    const url = new URL(safeReturnTo(returnTo, config), config.publicOrigin);
    url.searchParams.set("oidc", result);
    response.redirect(302, `${url.pathname}${url.search}${url.hash}`);
}

function transactionFor(request: Request, config: OidcConfig) {
    const transaction = openCookie<OidcTransaction>(cookieValue(request, transactionCookie.name), config.sessionKey);
    if (!transaction || typeof transaction.state !== "string" || typeof transaction.nonce !== "string" || typeof transaction.returnTo !== "string") return null;
    return transaction;
}

export function sessionFor(request: Request, config: OidcConfig) {
    const session = openCookie<OidcSessionPayload>(cookieValue(request, sessionCookie.name), config.sessionKey);
    if (
        !session || typeof session.accessToken !== "string" || typeof session.refreshToken !== "string" ||
        !Number.isSafeInteger(session.accessTokenExpiresAt) || !Number.isSafeInteger(session.refreshTokenExpiresAt) ||
        typeof session.subject !== "string" || session.issuer !== config.issuer.origin || !Array.isArray(session.scopes) ||
        !session.scopes.every((scope) => typeof scope === "string") || session.refreshTokenExpiresAt <= Date.now()
    ) return null;
    return session;
}

function sessionMaxAge(session: OidcSessionPayload) {
    return Math.max(0, session.refreshTokenExpiresAt - Date.now());
}

function storeSession(response: Response, config: OidcConfig, session: OidcSessionPayload) {
    const maxAge = sessionMaxAge(session);
    const value = sealCookie(session, config.sessionKey);
    const header = serializeCookie(sessionCookie.name, value, {
        ...sessionCookie.options(config, maxAge),
        expires: new Date(Date.now() + maxAge),
        maxAge: Math.floor(maxAge / 1000),
    });
    if (Buffer.byteLength(header) > maxSessionCookieBytes) {
        throw new Error("OIDC session Cookie 超出浏览器限制");
    }
    response.cookie(sessionCookie.name, value, sessionCookie.options(config, maxAge));
}

function newSession(config: OidcConfig, tokens: TokenResponse, subject: string, scopes: string[]): OidcSessionPayload {
    const now = Date.now();
    return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        accessTokenExpiresAt: now + tokens.expiresIn * 1000,
        refreshTokenExpiresAt: tokens.refreshTokenExpiresAt * 1000,
        subject,
        issuer: config.issuer.origin,
        scopes,
        createdAt: new Date(now).toISOString(),
    };
}

function clearSession(response: Response, config: OidcConfig) {
    response.clearCookie(sessionCookie.name, sessionCookie.options(config));
}

export function invalidSession(response: Response, config: OidcConfig) {
    clearSession(response, config);
    response.setHeader("X-OIDC-Session-Invalid", "1");
    return response.status(401).json({ code: "oidc_session_invalid" });
}

async function rotatedSession(config: OidcConfig, session: OidcSessionPayload, oidc: OidcClient) {
    const discovery = await oidc.discoveryFor(config);
    const tokens = await oidc.refresh(config, discovery, session.refreshToken);
    try {
        const scopes = parseScopes(tokens.scope);
        if (!sameScopes(scopes, session.scopes)) throw new Error("OIDC scope 不匹配");
        const subject = await oidc.verifyIdToken(config, discovery, tokens.idToken);
        if (subject !== session.subject) throw new Error("OIDC subject 不匹配");
        const refreshed = newSession(config, tokens, subject, scopes);
        refreshed.createdAt = session.createdAt;
        return refreshed;
    } catch {
        return null;
    }
}

async function refreshedSession(config: OidcConfig, response: Response, session: OidcSessionPayload, oidc: OidcClient) {
    if (session.refreshTokenExpiresAt <= Date.now()) return null;
    if (session.accessTokenExpiresAt > Date.now() + refreshSkewMs) return session;
    const key = createHash("sha256").update(session.refreshToken).digest("base64url");
    let refresh = refreshInFlight.get(key);
    if (!refresh) {
        refresh = rotatedSession(config, session, oidc).catch((error) => {
            if (error instanceof OidcTokenError && error.code === "invalid_grant") return null;
            throw error;
        });
        refreshInFlight.set(key, refresh);
        refresh.then(
            () => {
                // A browser can issue another request before it processes Set-Cookie.
                setTimeout(() => {
                    if (refreshInFlight.get(key) === refresh) refreshInFlight.delete(key);
                }, refreshReplayWindowMs).unref();
            },
            () => {
                if (refreshInFlight.get(key) === refresh) refreshInFlight.delete(key);
            },
        );
    }
    const refreshed = await refresh;
    if (refreshed) {
        try {
            storeSession(response, config, refreshed);
        } catch {
            return null;
        }
    }
    return refreshed;
}

function authorizationUrl(config: OidcConfig, discovery: Discovery, transaction: OidcTransaction) {
    const url = new URL(discovery.authorization_endpoint);
    url.search = new URLSearchParams({
        response_type: "code",
        client_id: config.clientId,
        redirect_uri: new URL("/api/oidc/callback", config.publicOrigin).toString(),
        scope: config.scopes.join(" "),
        state: transaction.state,
        nonce: transaction.nonce,
    }).toString();
    return url.toString();
}

export function createApp(config: OidcConfig | null, dependencies: OidcAppDependencies = {}): Express {
    const app = express();
    const oidc = { ...defaultOidcClient, ...dependencies.oidc };

    app.use(proxyPrefix, (request, response, next) => {
        if (!config) return response.status(404).json({ code: "oidc_disabled" });
        const session = sessionFor(request, config);
        if (!session || !sameScopes(session.scopes, config.scopes)) return invalidSession(response, config);
        void refreshedSession(config, response, session, oidc).then((currentSession) => {
            if (!currentSession) return invalidSession(response, config);
            return proxyGatewayRequest(config, request, response, currentSession, dependencies.proxy);
        }).catch(() => {
            if (!response.headersSent) response.status(502).json({ code: "oidc_unavailable" });
            else response.destroy();
        });
    });
    app.use(express.json({ limit: "16kb" }));
    app.get("/api/oidc/config", (_request, response) => {
        response.json({ enabled: Boolean(config), providerName: config?.providerName || "" });
    });

    app.post("/api/oidc/authorize", async (request, response) => {
        if (!config) return response.status(404).json({ code: "oidc_disabled" });
        try {
            const transaction: OidcTransaction = {
                state: randomBytes(24).toString("base64url"),
                nonce: randomBytes(24).toString("base64url"),
                returnTo: safeReturnTo(request.body?.returnTo, config),
            };
            const discovery = await oidc.discoveryFor(config);
            response.cookie(transactionCookie.name, sealCookie(transaction, config.sessionKey), transactionCookie.options(config));
            response.json({ authorizationUrl: authorizationUrl(config, discovery, transaction) });
        } catch {
            response.status(502).json({ code: "oidc_unavailable" });
        }
    });

    app.get("/api/oidc/callback", async (request, response) => {
        if (!config) return response.status(404).json({ code: "oidc_disabled" });
        const transaction = transactionFor(request, config);
        const state = typeof request.query.state === "string" ? request.query.state : "";
        const code = typeof request.query.code === "string" ? request.query.code : "";
        response.clearCookie(transactionCookie.name, transactionCookie.options(config));
        if (!transaction || state !== transaction.state || typeof request.query.error === "string" || !code) {
            return redirectOidcResult(response, transaction?.returnTo, "failed", config);
        }
        try {
            const discovery = await oidc.discoveryFor(config);
            const tokens = await oidc.exchangeCode(config, discovery, code);
            const scopes = parseScopes(tokens.scope);
            if (!sameScopes(scopes, config.scopes)) throw new Error("OIDC scope 不匹配");
            const subject = await oidc.verifyIdToken(config, discovery, tokens.idToken, transaction.nonce);
            const session = newSession(config, tokens, subject, scopes);
            storeSession(response, config, session);
            return redirectOidcResult(response, transaction.returnTo, "connected", config);
        } catch {
            clearSession(response, config);
            return redirectOidcResult(response, transaction.returnTo, "failed", config);
        }
    });

    app.get("/api/oidc/session", (request, response) => {
        if (!config) return response.json({ connected: false, providerName: "", approvedScopes: [] });
        const session = sessionFor(request, config);
        if (!session) return invalidSession(response, config);
        if (!sameScopes(session.scopes, config.scopes)) {
            clearSession(response, config);
            return response.json({ connected: false, providerName: config.providerName, approvedScopes: [] });
        }
        return response.json({ connected: true, providerName: config.providerName, approvedScopes: session.scopes });
    });

    app.get("/api/oidc/models", (request, response) => {
        if (!config) return response.status(404).json({ code: "oidc_disabled" });
        const session = sessionFor(request, config);
        if (!session || !sameScopes(session.scopes, config.scopes)) return invalidSession(response, config);
        return response.json(config.models);
    });

    app.delete("/api/oidc/session", async (request, response) => {
        if (!config) return response.status(204).end();
        const session = sessionFor(request, config);
        if (!session) return invalidSession(response, config);
        try {
            const discovery = await oidc.discoveryFor(config);
            await oidc.revoke(config, discovery, session.refreshToken);
        } catch {
            // Revocation is best-effort; the local browser session is always removed.
        }
        clearSession(response, config);
        response.clearCookie(transactionCookie.name, transactionCookie.options(config));
        return response.status(204).end();
    });

    return app;
}
