import i18n from "@/i18n";
import type { ApiCallFormat, ModelCapability } from "@/stores/use-config-store";

export type OidcModel = { id: string; platform: "openai" | "grok"; name: string; capability: ModelCapability; apiFormat: ApiCallFormat };
export type OidcSession = { connected: boolean; providerName: string; approvedScopes: string[] };
export type OidcPublicConfig = { enabled: boolean; providerName: string };

async function request<T>(path: string, init?: RequestInit) {
    const response = await fetch(path, { credentials: "same-origin", ...init });
    if (!response.ok) throw new Error(i18n.t("fork.oidc.requestFailed", { status: response.status }));
    return (await response.json()) as T;
}

export function getOidcConfig() {
    return request<OidcPublicConfig>("/api/oidc/config");
}

export function getOidcSession() {
    return request<OidcSession>("/api/oidc/session");
}

export function getOidcModels() {
    return request<OidcModel[]>("/api/oidc/models");
}

export function getOidcModelCatalog() {
    return request<OidcModel[]>("/api/oidc/model-catalog");
}

export async function beginOidcAuthorization(modelIds: string[], returnTo = "/config") {
    const data = await request<{ authorizationUrl: string }>("/api/oidc/authorize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ returnTo, modelIds }) });
    window.location.assign(data.authorizationUrl);
}

export async function disconnectOidc() {
    const response = await fetch("/api/oidc/session", { method: "DELETE", credentials: "same-origin" });
    if (!response.ok && response.status !== 401) throw new Error(i18n.t("fork.oidc.disconnectRequestFailed", { status: response.status }));
}
