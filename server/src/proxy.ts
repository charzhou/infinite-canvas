import { Readable } from "node:stream";
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";

import type { Request, Response } from "express";

import { sessionCookie } from "./cookies.js";
import type { OidcConfig } from "./config.js";
import type { OidcSessionPayload } from "./app.js";

export const proxyPrefix = "/api/oidc/proxy";

const allowedRoutes = [
    ["GET", /^\/v1\/models$/],
    ["POST", /^\/v1\/(chat\/completions|responses|images\/(generations|edits)|videos(?:\/generations)?|audio\/speech)$/],
    ["GET", /^\/v1\/videos\/[^/]+(?:\/content)?$/],
    ["GET", /^\/(v1beta|antigravity\/v1beta)\/models(?:\/[^/]+)?$/],
    ["POST", /^\/(v1beta|antigravity\/v1beta)\/models\/[^/:]+:(generateContent|streamGenerateContent|predictLongRunning)$/],
    ["GET", /^\/(v1beta|antigravity\/v1beta)\/[^/]+$/],
] as const;

const requestHeaders = ["accept", "content-type", "range", "x-request-id", "x-correlation-id", "traceparent", "tracestate"];
const responseHeaders = ["accept-ranges", "cache-control", "content-disposition", "content-range", "content-type", "etag", "last-modified", "location", "retry-after", "x-request-id", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"];
const proxyDispatchers = new Map<number, Dispatcher>();

export type ProxyDependencies = {
    fetch?: typeof fetch;
    dispatcherFor?: (timeoutMs: number) => Dispatcher;
};

function dispatcherFor(timeoutMs: number) {
    let dispatcher = proxyDispatchers.get(timeoutMs);
    if (!dispatcher) {
        dispatcher = new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
        proxyDispatchers.set(timeoutMs, dispatcher);
    }
    return dispatcher;
}

function targetFor(request: Request) {
    const raw = request.originalUrl.slice(proxyPrefix.length);
    const queryIndex = raw.indexOf("?");
    const rawPath = queryIndex < 0 ? raw : raw.slice(0, queryIndex);
    const query = queryIndex < 0 ? "" : raw.slice(queryIndex);
    let path: string;
    try {
        path = decodeURIComponent(rawPath);
    } catch {
        return null;
    }
    if (!rawPath.startsWith("/") || rawPath.startsWith("//") || rawPath.includes("..") || rawPath.includes("//") || path.includes("..") || path.includes("//")) return null;
    if (!allowedRoutes.some(([method, pattern]) => method === request.method && pattern.test(path))) return null;
    return `${rawPath}${query}`;
}

function sameOriginWrite(request: Request, config: OidcConfig) {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return true;
    return request.get("origin") === config.publicOrigin.origin;
}

function copiedRequestHeaders(request: Request, accessToken: string) {
    const headers = new Headers();
    for (const name of requestHeaders) {
        const value = request.get(name);
        if (value) headers.set(name, value);
    }
    headers.set("Authorization", `Bearer ${accessToken}`);
    return headers;
}

async function invalidToken(response: globalThis.Response) {
    if (response.status !== 401) return false;
    const authenticate = response.headers.get("www-authenticate") || "";
    if (/\binvalid_token\b/i.test(authenticate)) return true;
    return /\binvalid_token\b/i.test(await response.clone().text().catch(() => ""));
}

function copyResponseHeaders(upstream: globalThis.Response, response: Response) {
    for (const name of responseHeaders) {
        const value = upstream.headers.get(name);
        if (value) response.setHeader(name, value);
    }
}

function proxyErrorCode(error: unknown) {
    const cause = error instanceof Error ? error.cause : undefined;
    if (!cause || typeof cause !== "object" || !("code" in cause)) return undefined;
    const code = (cause as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
}

function retryableVideoStatusRequest(request: Request, target: string, error: unknown) {
    return request.method === "GET" && /^\/v1\/videos\/[^/]+$/.test(target.split("?", 1)[0]) && proxyErrorCode(error) === "ECONNRESET";
}

export async function proxyGatewayRequest(config: OidcConfig, request: Request, response: Response, session: OidcSessionPayload, dependencies: ProxyDependencies = {}) {
    const target = targetFor(request);
    if (!target || !sameOriginWrite(request, config)) return response.status(404).json({ code: "oidc_proxy_not_found" });

    try {
        const method = request.method;
        const hasBody = !["GET", "HEAD"].includes(method);
        const init = {
            method,
            headers: copiedRequestHeaders(request, session.accessToken),
            body: hasBody ? (request as unknown as ReadableStream) : undefined,
            duplex: "half",
            signal: AbortSignal.timeout(config.proxyTimeoutMs),
            dispatcher: (dependencies.dispatcherFor || dispatcherFor)(config.proxyTimeoutMs),
        } as RequestInit & { duplex: "half"; dispatcher: Dispatcher };
        const url = new URL(target, config.gatewayBaseUrl);
        const gatewayFetch = () => dependencies.fetch
            ? dependencies.fetch(url, init)
            : undiciFetch(url, init as Parameters<typeof undiciFetch>[1]) as unknown as Promise<globalThis.Response>;
        let upstream: globalThis.Response;
        try {
            upstream = await gatewayFetch();
        } catch (error) {
            if (!retryableVideoStatusRequest(request, target, error)) throw error;
            upstream = await gatewayFetch();
        }
        const sessionInvalid = await invalidToken(upstream);
        if (sessionInvalid) {
            response.clearCookie(sessionCookie.name, sessionCookie.options(config));
            response.setHeader("X-OIDC-Session-Invalid", "1");
        }
        copyResponseHeaders(upstream, response);
        response.status(upstream.status);
        if (!upstream.body) return response.end();
        Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream).on("error", () => response.destroy()).pipe(response);
    } catch (error) {
        console.error("OIDC gateway request failed", { method: request.method, path: target.split("?", 1)[0], error: error instanceof Error ? error.message : String(error), code: proxyErrorCode(error) });
        if (!response.headersSent) return response.status(502).json({ code: "oidc_gateway_unavailable" });
        response.destroy();
    }
}
