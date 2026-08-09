# Fireweave SDK — Privacy Documentation

**Status:** Phase-4 security/privacy review (Agent J, 2026-07-27). Every claim below was verified against SDK source; file references are given inline.

## 1. What the SDK sends, and when

The Fireweave SDK is **server-first** (docs/adr/0004): it runs in your backend, never in a browser or mobile app, and talks only to the endpoint you configure (host-allowlist enforced — see §6). On Node that endpoint is **fw-server**; on the other languages it may be fw-server or, via the optional direct adapter, a vendor endpoint. There are exactly three categories of outbound data:

### 1.1 Control-point evaluation requests

Sent on each evaluation in remote mode; not sent at all in in-memory mode, or in local-evaluation mode where a language still offers it.

**Node (2.1):** requests go to fw-server at `POST /v1/flags/evaluate` (`sdks/node/packages/sdk/src/adapters/remote.ts`). No vendor endpoint is contacted from the application process at all. Contains:

- `targetingKey` — verbatim.
- `attributes` — the evaluation-context attributes you supply, minus `groups`/`groupProperties`, `$`-prefixed system directives, and `fireweave.*` carriers.
- `groups` / `groupProperties` when you supply them.

**Python / Go / Java, and any language using the direct vendor adapter,** additionally send:

- `distinct_id` — your `targetingKey`, verbatim.
- **Person properties** — the context attributes you supply, passed through so the backend can target on them. Verified per language: Python forwards `plain_attributes` minus group keys (`sdks/python/src/fireweave/adapters/posthog.py` lines 282–291), Go forwards everything except `groups`/`groupProperties`/`$`-directives (`sdks/go/adapters/posthog/posthog.go` lines 297–343), Java passes attributes through the client seam (`PostHogAdapter.java` line 125).
- **Group memberships and group properties** when you supply them (`groups`/`groupProperties` attributes; Python additionally accepts the spec carriers `fireweave.groups`/`fireweave.groupProperties`, `context.py` lines 29–31, 92–103).
- GeoIP enrichment is disabled where the vendor SDK exposes the switch. (Not applicable to Node as of 2.1 — there is no vendor SDK in the process.)

**The SDK never invents attributes.** If you put PII (email, phone) into the context, it is forwarded — to fw-server on Node, to the vendor directly elsewhere — and becomes targetable. That is the targeting feature working as designed. The canonical spec marks this explicitly (`spec/evaluation-context.schema.json` → `piiAndRedaction.contextMayContainPii: true`). If you must target on sensitive fields, prefer derived attributes (e.g. `email_domain` as used in `contracts/context/ctx-person-and-groups.json`) over raw values.

### 1.2 Exposure events (`$feature_flag_called`)

**Fireweave-owned, deduplicated, never implicit.** Exposures are recorded only through Fireweave's explicit, deduplicated queue — evaluation itself is side-effect-free unless you opt in with `sendExposure`.

**Node (2.1):** exposures batch to `POST /v1/capture`; there is no vendor emission path to suppress, because there is no vendor SDK in the process.

**Python / Go / Java:** each adapter suppresses the vendor SDK's implicit emission — Python reads snapshot records without touching accessor methods that fire events (`adapters/posthog.py` lines 142–148), Go installs a `BeforeSend` gate that drops implicit events unless armed (`adapters/posthog/exposure.go`, `posthog.go` lines 18–22, 285–287), Java dedups on `(distinctId, flagKey, variant, value)` (`PostHogAdapter.java` lines 46–50, 253–272).

An exposure event contains: targeting key, control-point key, variant/value, and optional rollout identifiers — no context attributes.

### 1.3 Signals (release-safety telemetry)

Opt-in per call (`signals.recordHealth/recordError/recordMetric/recordOutcome`). **Allowlist + redaction applied before anything is recorded:**

- **Go:** hard-coded key allowlist (flagKey, variant, value, rollout/change/stamp ids, status, name, kind, errorKind, message, metricValue); every string value passes `Redact()` (`sdks/go/fireweave/telemetry.go`).
- **Python:** hard-coded allowlist `_SIGNAL_ATTRIBUTE_ALLOWLIST`; unknown attributes are silently dropped; strings are redacted (`sdks/python/src/fireweave/client.py` lines 40–58, 286–294).
- **Java:** signals have a fixed canonical field set (no arbitrary attributes); `message` is sanitized at construction (`Signal.java` line 46); a config allowlist can filter further (`FireweaveConfig.java` lines 146–149).
- **Node:** string values are redacted and the attribute allowlist is **on by default** — `DEFAULT_SIGNAL_ATTRIBUTE_ALLOWLIST` (finding M-3, resolved), overridable via `FireweaveClientOptions.telemetry.attributeAllowlist`. Attributes outside the list are dropped before recording.

Release failure reasons (`releases.fail(reason)`) are redacted in every language before storage or emission (Node `client.ts` line 120, Python `client.py` line 159, Go `client.go` "Fail marks the bound release failed with a safe (redacted) reason", Java `FireweaveClient.java` line 185).

## 2. Default data capture per language (verified)

| | Node | Python | Go | Java |
|---|---|---|---|---|
| Context attributes forwarded on evaluate | yes → fw-server (`/v1/flags/evaluate`) | yes (remote mode) | yes (remote mode) | via injected client seam |
| Vendor implicit exposure events (OF/evaluate path) | n/a — no vendor SDK in process (2.1); evaluate opt-in via `sendExposure: true` (ruling 20) | disabled (`exposureEmission: false`); evaluate opt-in via `send_exposure=True` | gated (off unless `SendExposureEvents` / per-call arm + deduped) | Fireweave-owned via seam; evaluate opt-in via `sendExposure(true)` (default false; ruling 20) |
| Fireweave exposures | explicit queue, dedup, flush | explicit queue, dedup, flush | explicit queue, dedup, flush | explicit queue, dedup, flush |
| Signals | opt-in per call | opt-in per call | opt-in per call | opt-in per call |
| GeoIP | n/a — no vendor SDK in process | vendor default | vendor default | injected-client dependent |
| Anything persisted to disk | **no** | **no** | **no** | **no** |
| Telemetry attribute allowlist default | enforced allowlist | enforced allowlist | enforced allowlist | fixed field set |

"Nothing persisted to disk" was verified by grep across all four SDK source trees: no file-write APIs exist outside the Java conformance *test* harness (`fireweave-testing/.../ConformanceRunner.java:118`). Local-evaluation flag definitions live only in vendor-SDK memory.

## 3. PII policy

1. **The SDK adds no PII of its own.** Every person property on the wire originated in a caller-supplied evaluation context.
2. **Error messages never carry attribute values or secrets.** All bound-violation and backend-fault messages are fixed canonical strings (verified in threat-model.md §R2 with file references); fixture `sec-pii-redaction-in-messages` asserts that an email/phone in the context cannot appear in `errorMessage`, and passes in all four languages.
3. **Secrets are structurally excluded from telemetry**: `phc_`/`phs_`/`phx_` keys, bearer tokens, and `FW_PROJECT_API_KEY` assignments are pattern-redacted from every message and signal string (Node `errors.ts` 72–85, Python `errors.py` 116–127, Go `errors.go` 152–166, Java `Redaction.java`).
4. **Context bounds double as a PII blast-radius cap**: at most 128 attributes / 4 KiB per value / 64 KiB serialized can ever leave the process per evaluation, enforced before serialization in all four languages (threat-model.md §R4).
5. **Logging:** the spec forbids dumping full evaluation contexts at default log levels (`spec/evaluation-context.schema.json` `defaultLogFullContext: false`); the Go adapter goes further and silences the vendor logger entirely (`posthog.go` 556–563).

## 4. Anonymous IDs and identity linkability — an honest explanation

The `targetingKey` you pass is forwarded verbatim and never rewritten: as `targetingKey` to fw-server on Node (`adapters/remote.ts`), and as the vendor `distinct_id` where a direct adapter is in use (Python `adapters/posthog.py` line 282, Go `posthog.go` line 303, Java `PostHogAdapter.java` lines 117–121).

Be clear-eyed about what this means:

- If you pass a stable pseudonymous ID (e.g. `user_01HZX…`), whatever stores it can correlate **every control-point evaluation and exposure for that ID over time**, and can join it with any other events your product sends under the same identifier — including ones that carry real identity (email on signup, etc.). An "anonymous" targeting key is only as anonymous as its weakest join. Routing through fw-server does not change this: it moves *where* the correlation happens, not *whether* it can.
- The contract fixture `ctx-stable-anonymous-identity.json` requires anonymous identities to be *stable* — that is a product requirement (consistent bucketing), and it is inherently in tension with unlinkability. Stability **is** linkability.
- Attributes sent for targeting attach to that identifier's profile in whatever backend stores it. Sending `email: alice@example.com` as a targeting attribute de-anonymizes the ID for anyone with access to that project.
- The SDK does not hash, salt, or rotate targeting keys, and does not implement any backend's profile opt-outs on your behalf. If you need unlinkable evaluation, derive the targeting key yourself (e.g. HMAC of the user ID with a key you never send) and pass only coarse, non-identifying attributes.

## 5. Tenant boundaries

- **Process-level:** no shared mutable state can mix person/group properties across concurrent requests — verified per language in threat-model.md §R6 (Java: no ThreadLocal, per-call explicit properties; Python: RLock + frozen deep-copied contexts; Go: race-tested, no package mutable state; Node: fresh deep-copied merge per evaluation). One documented best-effort edge: Node/Go response-metadata interception is keyed by `distinct_id`, so two concurrent evaluations *of the same identity* may swap flag *metadata* (never properties).
- **Client/domain-level:** multiple runtimes with different keys/hosts can coexist in one process (fixture `life-multi-client-domain`); each runtime owns its adapter and context layers — nothing is process-global.
- **Backend-level:** tenant separation is the project boundary — one Fireweave project key = one project (or, where a direct vendor adapter is in use, one vendor project key = one vendor project). The SDK cannot cross projects: the key is fixed at construction, immutable in every language's config (`FireweaveConfig` frozen dataclass / final fields / copied structs).

## 6. Data flow

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
                        other: vendor endpoints, where a direct adapter is configured
```

- Egress hosts are allowlist-checked at initialization; the allowlist is **on by default** in every language (H-1, resolved). Node's `DEFAULT_ALLOWED_HOSTS` names Fireweave's own hosts plus loopback — no vendor hostname appears in the published build at all ([ADR-0006](adr/0006-node-drops-direct-posthog-adapter.md)). The SSRF fixture (`sec-endpoint-ssrf-allowlist`) pins the allowlist *shape*, supplying its own hosts explicitly.
- `https` is required for anything leaving the machine; plain `http` is permitted on loopback only (the local test stub).
- TLS verification is ecosystem-default (never disabled anywhere in the repo); proxies follow ecosystem conventions (`HTTPS_PROXY` etc.).
- **On Node, the application never holds a vendor credential or contacts a vendor host.** Whatever fw-server forwards onward is governed by your Fireweave project configuration and DPA.
- Retention, deletion, and DSAR handling for data that leaves the SDK are governed by your project settings and DPA — the SDK keeps no copy (nothing on disk, queues drain on flush/shutdown).
