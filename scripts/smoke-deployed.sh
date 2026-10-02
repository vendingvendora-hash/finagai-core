#!/usr/bin/env bash
# Smoke test of a DEPLOYED Finagai Core. Uses no credentials.
#   usage: scripts/smoke-deployed.sh https://<service>.onrender.com https://<authkit-subdomain>.authkit.app
set -uo pipefail
BASE="${1:?base URL}"; ISSUER="${2:?issuer URL}"
fail=0
check() { if eval "$2"; then echo "PASS  $1"; else echo "FAIL  $1"; fail=1; fi; }
warn()  { if eval "$2"; then echo "PASS  $1"; else echo "WARN  $1"; fi; }

health="$(curl -fsS "$BASE/health" 2>/dev/null)"
check "health endpoint is up" '[[ "$(jq -r .status <<<"$health")" == ok ]]'
meta="$(curl -fsS "$BASE/.well-known/oauth-protected-resource" 2>/dev/null)"
check "protected-resource metadata names the exact MCP URL" '[[ "$(jq -r .resource <<<"$meta")" == "$BASE/mcp" ]]'
check "protected-resource metadata names the identity provider first" '[[ "$(jq -r ".authorization_servers[0]" <<<"$meta")" == "$ISSUER" ]]'
hdr="$(curl -sS -o /dev/null -D - -X POST "$BASE/mcp" 2>/dev/null)"
check "/mcp without a token: 401 with resource_metadata challenge" 'grep -q "^HTTP/[0-9.]* 401" <<<"$hdr" && grep -qi "resource_metadata=\"$BASE/.well-known/oauth-protected-resource\"" <<<"$hdr"'
hdr="$(curl -sS -o /dev/null -D - -X POST -H "authorization: Bearer a.b.c" "$BASE/mcp" 2>/dev/null)"
check "/mcp with an invalid token: 401 invalid_token" 'grep -q "^HTTP/[0-9.]* 401" <<<"$hdr" && grep -qi "invalid_token" <<<"$hdr"'
code="$(curl -sS -o /dev/null -w "%{http_code}" -X POST -H "authorization: Bearer a.b.c" -H "content-type: application/json" -H "origin: $BASE" -d '{}' "$BASE/approve/enroll/begin")"
check "approval endpoints refuse bearer tokens" '[[ "$code" == 401 ]]'
disco="$(curl -fsS "${ISSUER%/}/.well-known/openid-configuration" 2>/dev/null)"
check "identity provider discovery is reachable" '[[ -n "$disco" && "$(jq -r .issuer <<<"$disco")" == "$ISSUER" ]]'
loc="$(curl -sS -o /dev/null -w "%{redirect_url}" "$BASE/approve/login")"
check "approval sign-in redirects to the identity provider with PKCE" '[[ "$loc" == "$(jq -r .authorization_endpoint <<<"$disco")"* && "$loc" == *code_challenge_method=S256* ]]'
asm="$(curl -fsS "${ISSUER%/}/.well-known/oauth-authorization-server" 2>/dev/null)"
check "authorization server advertises S256 PKCE (required by Claude)" 'jq -e ".code_challenge_methods_supported | index(\"S256\")" <<<"$asm" >/dev/null'
warn  "authorization server advertises Client ID Metadata Documents (Claude prefers CIMD)" 'jq -e ".client_id_metadata_document_supported == true" <<<"$asm" >/dev/null'
exit $fail
