import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { OidcConfig } from "./config.js";

export type CookieOptions = {
    httpOnly: true;
    sameSite: "lax";
    path: "/";
    secure: boolean;
    maxAge: number;
};

function cookieOptions(config: OidcConfig, maxAge: number): CookieOptions {
    return {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: config.publicOrigin.protocol === "https:",
        maxAge,
    };
}

export const transactionCookie = {
    name: "oidc_transaction",
    options: (config: OidcConfig) => cookieOptions(config, 10 * 60 * 1000),
};

export const sessionCookie = {
    name: "oidc_session",
    options: (config: OidcConfig) => cookieOptions(config, 30 * 24 * 60 * 60 * 1000),
};

export function sealCookie<T>(value: T, key: Uint8Array) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return [nonce, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(".");
}

export function openCookie<T>(value: string | undefined, key: Uint8Array): T | null {
    try {
        const parts = value?.split(".");
        if (!parts || parts.length !== 3 || parts.some((part) => !part)) return null;
        const [nonce, tag, ciphertext] = parts.map((part) => Buffer.from(part, "base64url"));
        if (nonce.byteLength !== 12 || tag.byteLength !== 16 || !ciphertext.byteLength) return null;
        const decipher = createDecipheriv("aes-256-gcm", key, nonce);
        decipher.setAuthTag(tag);
        return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")) as T;
    } catch {
        return null;
    }
}
