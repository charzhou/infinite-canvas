# OIDC Gateway CDN Base URL Design

## Goal

Allow the OIDC compute channel to use a CDN-backed LLM gateway while preserving the Provider's canonical OIDC issuer for discovery and ID Token validation.

## Configuration

Add optional `OIDC_GATEWAY_BASE_URL`.

- `OIDC_ISSUER` remains the canonical bare HTTPS origin. It is used for `/.well-known/openid-configuration`, the expected ID Token `iss`, and the discovery-provided authorization, token, revocation, and JWKS endpoints.
- `OIDC_GATEWAY_BASE_URL`, when set, is a bare HTTP(S) origin used only as the base URL for the constrained `/api/oidc/proxy/*` LLM requests.
- When `OIDC_GATEWAY_BASE_URL` is absent, the proxy continues to use `OIDC_ISSUER`.
- `PUBLIC_ORIGIN` remains the public browser-facing origin and is not changed by this feature.

The deployment value for this Provider is:

```text
OIDC_ISSUER=https://ai.nekotech.us
OIDC_GATEWAY_BASE_URL=https://sub2api.tegical.com
```

## Request Flow

1. The BFF reads OIDC discovery from `OIDC_ISSUER`.
2. Browser authorization, code exchange, token revocation, and ID Token verification use the discovery metadata and canonical issuer.
3. A permitted browser request to `/api/oidc/proxy/v1/...` is validated against the existing route allowlist and same-origin write policy.
4. The BFF replaces browser credentials with the sealed-session Access Token and sends the request to `OIDC_GATEWAY_BASE_URL`, preserving only the existing allowlisted headers and request body.

No browser-controlled URL, host, or Authorization value influences the gateway target.

## Validation and Deployment

`OIDC_GATEWAY_BASE_URL` uses the same bare-origin validation as `OIDC_ISSUER`: HTTP(S) only, no user info, path, query, or fragment. The Knative Secret example, Docker guidance, and OIDC configuration example include the optional variable.

The CDN must transparently pass authenticated `/v1/*` traffic, streaming responses, `Range`, and binary media. It must not cache bearer-authenticated API responses by default.

## Tests

- Configuration loads the gateway base when configured and falls back to the issuer when omitted.
- Invalid gateway base values are rejected.
- The constrained proxy sends approved requests to the gateway base while retaining the issuer in the sealed session and OIDC flow.
