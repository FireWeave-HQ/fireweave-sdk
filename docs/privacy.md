# Fireweave SDK — Privacy Documentation

## 1. What the SDK sends, and when

The Fireweave SDK talks only to the endpoint you configure (host-allowlist enforced — see §5).

### 1.1 Control-point evaluation requests

Sent in remote mode — on each evaluation, or per context in the SDKs that prefetch (web, Swift); not sent in local mode (or with `InMemoryAdapter`).

**Node:** requests go to fw-server at `POST /v1/flags/evaluate`. No vendor endpoint is contacted from the application process at all. Contains:

- `targetingKey` — verbatim.
- `attributes` — the evaluation-context attributes you supply, minus `groups`/`groupProperties`, `$`-prefixed system directives, and `fireweave.*` carriers.
- `groups` / `groupProperties` when you supply them.

**The SDK never invents attributes.** If you put PII (email, phone) into the context, it is forwarded and becomes targetable. That is the targeting feature working as designed. The canonical spec marks this explicitly (`spec/evaluation-context.schema.json` → `piiAndRedaction.contextMayContainPii: true`). If you must target on sensitive fields, prefer derived attributes (e.g. `email_domain` as used in `contracts/context/ctx-person-and-groups.json`) over raw values.

### 1.2 Exposure events (Node, opt-in)

Evaluation is side-effect-free by default. On Node, passing `sendExposure: true` to `controlPoints.evaluate(...)` records a deduplicated exposure, batched to `POST /v1/capture`. An exposure contains the targeting key, control-point key, value and variant — no context attributes.

## 2. PII policy

1. **The SDK adds no PII of its own.** Every person property on the wire originated in a caller-supplied evaluation context.
2. **Error messages never carry attribute values or secrets.** All bound-violation and backend-fault messages are fixed canonical strings; fixture `sec-pii-redaction-in-messages` asserts that an email/phone in the context cannot appear in `errorMessage`, and passes in Node, Python, Go and Java.
3. **Secrets are structurally excluded from error messages**: `phc_`/`phs_`/`phx_` keys, bearer tokens, and (except in Go) `FW_PROJECT_API_KEY` assignments are pattern-redacted from every message string (Node `errors.ts` 72–85, Python `errors.py`, Go `errors.go`, Java `Redaction.java`).
4. **Context bounds double as a PII blast-radius cap**: at most 128 attributes / 4 KiB per value / 64 KiB serialized can ever leave the process per evaluation, enforced before serialization in Node, Python, Go and Java.
5. **Logging:** the spec forbids dumping full evaluation contexts at default log levels (`spec/evaluation-context.schema.json` `defaultLogFullContext: false`).

## 3. Anonymous IDs and identity linkability — an honest explanation

The `targetingKey` you pass is forwarded verbatim and never rewritten: as `targetingKey` to fw-server.

Be clear-eyed about what this means:

- If you pass a stable pseudonymous ID (e.g. `user_01HZX…`), whatever stores it can correlate **every control-point evaluation and exposure for that ID over time**, and can join it with any other events your product sends under the same identifier — including ones that carry real identity (email on signup, etc.). An "anonymous" targeting key is only as anonymous as its weakest join. Routing through fw-server does not change this: it moves *where* the correlation happens, not *whether* it can.
- The contract fixture `ctx-stable-anonymous-identity.json` requires anonymous identities to be *stable* — that is a product requirement (consistent bucketing), and it is inherently in tension with unlinkability. Stability **is** linkability.
- Attributes sent for targeting attach to that identifier's profile in whatever backend stores it. Sending `email: alice@example.com` as a targeting attribute de-anonymizes the ID for anyone with access to that project.
- The SDK does not hash, salt, or rotate targeting keys, and does not implement any backend's profile opt-outs on your behalf. If you need unlinkable evaluation, derive the targeting key yourself (e.g. HMAC of the user ID with a key you never send) and pass only coarse, non-identifying attributes.

## 4. Tenant boundaries

- **Process-level:** no shared mutable state can mix person/group properties across concurrent requests (Java: no ThreadLocal, per-call explicit properties; Python: RLock + frozen deep-copied contexts; Go: race-tested, no package mutable state; Node: fresh deep-copied merge per evaluation).
- **Client/domain-level:** multiple runtimes with different keys/hosts can coexist in one process (fixture `life-multi-client-domain`); each runtime owns its adapter and context layers — nothing is process-global.
- **Backend-level:** tenant separation is the project boundary — one Fireweave project key = one project.

## 5. Data flow

```
caller context ──▶ merge (global→client→invocation) ──▶ bounds+reserved-key validation
                                                            │ (reject: no network, fixed message)
                                                            ▼
                                              adapter payload build
                             targetingKey · attributes · groups (no rewriting)
                                                            │
                                             host-allowlist-validated endpoint, TLS default-on
                                                            ▼
                        Node:  fw-server /v1/flags/evaluate · /v1/capture · /v1/targets/register
```

- Egress hosts are allowlist-checked at initialization; the allowlist is **on by default** in every language. Node's `DEFAULT_ALLOWED_HOSTS` names Fireweave's own hosts plus loopback — no vendor hostname appears in the published build at all ([ADR-0006](adr/0006-node-drops-direct-posthog-adapter.md)). The SSRF fixture (`sec-endpoint-ssrf-allowlist`) pins the allowlist *shape*, supplying its own hosts explicitly.
- `https` is required for anything leaving the machine; plain `http` is permitted on loopback only (the local test stub).
- TLS verification is ecosystem-default (never disabled anywhere in the repo); proxies follow ecosystem conventions (`HTTPS_PROXY` etc.).
- **On Node, the application never holds a vendor credential or contacts a vendor host.** Whatever fw-server forwards onward is governed by your Fireweave project configuration and DPA.
- Retention, deletion, and DSAR handling for data that leaves the SDK are governed by your project settings and DPA — the SDK keeps no copy (nothing on disk, queues drain on flush/shutdown).
