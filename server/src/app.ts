import { randomBytes } from "node:crypto";

import { parse as parseCookie } from "cookie";
import express, { type Express, type Request, type Response } from "express";

import { openCookie, sealCookie, sessionCookie, transactionCookie } from "./cookies.js";
import { parseScopes, type OidcConfig } from "./config.js";
import { discoveryFor, exchangeCode, revokeAccessToken, verifyIdToken, type Discovery, type TokenResponse } from "./oidc.js";

export type OidcTransaction = {
    state: string;
    nonce: string;
    returnTo: string;
};

export type OidcSessionPayload = {
    accessToken: string;
    subject: string;
    issuer: string;
    scopes: string[];
    createdAt: string;
};

type OidcClient = {
    discoveryFor: (config: OidcConfig) => Promise<Discovery>;
    exchangeCode: (config: OidcConfig, discovery: Discovery, code: string) => Promise<TokenResponse>;
    verifyIdToken: (config: OidcConfig, discovery: Discovery, idToken: string, nonce: string) => Promise<string>;
    revoke: (config: OidcConfig, discovery: Discovery, accessToken: string) => Promise<void>;
};

export type OidcAppDependencies = {
    oidc?: Partial<OidcClient>;
};

const defaultOidcClient: OidcClient = {
    discoveryFor,
    exchangeCode,
    verifyIdToken,
    revoke: revokeAccessToken,
};

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

function sessionFor(request: Request, config: OidcConfig) {
    const session = openCookie<OidcSessionPayload>(cookieValue(request, sessionCookie.name), config.sessionKey);
    if (!session || typeof session.accessToken !== "string" || typeof session.subject !== "string" || session.issuer !== config.issuer.origin || !Array.isArray(session.scopes) || !session.scopes.every((scope) => typeof scope === "string")) return null;
    return session;
}

function clearSession(response: Response, config: OidcConfig) {
    response.clearCookie(sessionCookie.name, sessionCookie.options(config));
}

function invalidSession(response: Response, config: OidcConfig) {
    clearSession(response, config);
    return response.status(401).json({ code: "oidc_session_invalid" });
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
            const session: OidcSessionPayload = { accessToken: tokens.accessToken, subject, issuer: config.issuer.origin, scopes, createdAt: new Date().toISOString() };
            response.cookie(sessionCookie.name, sealCookie(session, config.sessionKey), sessionCookie.options(config));
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
            await oidc.revoke(config, discovery, session.accessToken);
        } catch {
            // Revocation is best-effort; the local browser session is always removed.
        }
        clearSession(response, config);
        response.clearCookie(transactionCookie.name, transactionCookie.options(config));
        return response.status(204).end();
    });

    return app;
}
