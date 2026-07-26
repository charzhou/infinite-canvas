import assert from "node:assert/strict";
import test from "node:test";

import { openCookie, sealCookie } from "../src/cookies.js";

const testKey = Buffer.alloc(32, 11);

test("opens an encrypted cookie envelope with its original key", () => {
    const sealed = sealCookie({ token: "derived-token" }, testKey);

    assert.deepEqual(openCookie<{ token: string }>(sealed, testKey), { token: "derived-token" });
    assert.doesNotMatch(sealed, /derived-token/);
});

test("cookie ciphertext cannot be opened after tampering", () => {
    const sealed = sealCookie({ token: "derived-token" }, testKey);
    const [nonce, tag, ciphertext] = sealed.split(".");
    const replacement = tag[0] === "A" ? "B" : "A";

    assert.equal(openCookie<{ token: string }>(`${nonce}.${replacement}${tag.slice(1)}.${ciphertext}`, testKey), null);
});

test("returns null for malformed cookie envelopes", () => {
    assert.equal(openCookie("not.a.valid.cookie", testKey), null);
});
