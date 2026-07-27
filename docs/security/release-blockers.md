# Fireweave SDK — Security Findings & Release Gate

**Status:** Phase-4 security review (Agent J, 2026-07-27).
**Verdict: no RELEASE BLOCKERS.** The designed safeguards — secret hygiene, fixed error messages with redaction, pre-network context bounds, host allowlisting, bounded retries, TLS defaults, no disk persistence, no dynamic evaluation — were verified working in all four languages (evidence in [threat-model.md](threat-model.md)). The findings below are graded HIGH/MEDIUM/LOW and should be triaged before first publish; none involves an actual credential leak or an exploitable remote path in the default server-side deployment.

Counts: **0 RELEASE BLOCKER · 2 HIGH · 5 MEDIUM · 6 LOW.**

---

## HIGH

### H-1 · Host allowlist is off by default in Node and Python

- **Where:** `sdks/node/packages/sdk/src/runtime.ts` lines 33–34 ("Empty/undefined ⇒ any http(s) host") and 70–78; `sdks/python/src/fireweave/config.py` lines 41, 61–63 (`allowed_hosts: Optional[…] = None`, checked only `if … is not None`).
- **Contrast:** Go ships `defaultAllowedHosts` (five PostHog hosts + loopback, `sdks/go/adapters/posthog/posthog.go` lines 49–56); Java ships `DEFAULT_ALLOWED_HOSTS` (`FireweaveConfig.java` lines 18–20). Both deny unknown hosts out of the box.
- **Impact:** a Node/Python service whose PostHog host is attacker-influencable (env var injection, config service compromise) can be pointed at internal endpoints (e.g. `http://169.254.169.254`) carrying the project key in requests. The `sec-endpoint-ssrf-allowlist` fixture passes only because it supplies `allowedHosts` explicitly.
- **Fix (owners: Agents F, G):** adopt the Go/Java default allowlist in Node and Python; require an explicit `allowedHosts: ["*"]`-style opt-out for self-hosted PostHog. Behavior change is config-compatible for the documented PostHog hosts.

### H-2 · Node interpolates stringified vendor/internal errors into the outward `errorMessage`

- **Where:** `sdks/node/packages/sdk/src/runtime.ts` line 246: `new FireweaveError('Internal', { cause: err, message: redactSecrets(String(err)) })`, surfaced verbatim via `errorDecision` (`errorMessage: err.message`, lines 310–323).
- **Contrast:** Go documents and enforces "vendor error text never reaches Message" (`adapters/posthog/posthog.go` lines 428–429, `runtime.go` 199–208); Python wraps as `InternalError("evaluation failed")` with the cause on `__cause__` only (`runtime.py` 246–249); Java uses `ErrorKind.Internal.defaultMessage()` (`PostHogAdapter.java` line 129).
- **Impact:** `redactSecrets` catches only known secret shapes; arbitrary third-party exception text (URLs with query strings, response fragments, echoes of person attributes from vendor code) can reach callers and their logs through OpenFeature `errorMessage`. This weakens the `sec-pii-redaction-in-messages` guarantee on exactly the path where errors are least predictable.
- **Fix (owner: Agent F):** use the fixed taxonomy message (`safeMessage`) for non-Fireweave exceptions; keep the original on `cause` only. One-line change; `errors.ts` already defines `safeMessage` for this purpose (lines 103–104, 116).

## MEDIUM

### M-1 · Shutdown timeouts unenforced in Python, Java, and Node (config exists, nothing consumes it)

- **Python:** `FireweaveRuntime.shutdown` passes `timeout_ms` down (`runtime.py` lines 180–190) but `PostHogAdapter.shutdown(timeout_ms)` ignores the argument and calls vendor `flush()`/`shutdown()` unbounded (`adapters/posthog.py` lines 263–274). posthog-python joins consumer threads on shutdown; a wedged network can hang process exit.
- **Java:** `FireweaveRuntime.shutdown()` calls `adapter.shutdown()` with no deadline (`FireweaveRuntime.java` lines 193–205); `FireweaveConfig.shutdownTimeoutMs` (default 10 000, `FireweaveConfig.java` line 23) is never read on that path; boundedness currently depends entirely on the injected client's `close()`.
- **Node:** `FireweaveRuntimeConfig.shutdownTimeoutMs` (`runtime.ts` lines 41–43) is dead config; the adapter hardcodes `client.shutdown(2000)` (`adapters/posthog.ts` line 393).
- **Contrast:** Go is correct — caller context or `DefaultCloseTimeout` (5 s) bounds `Close` in a select race (`adapters/posthog/posthog.go` lines 44–47, 476–511).
- **Fix (owners: Agents F, G, I):** wire the configured timeout through to a bounded wait around vendor close (Go's select/race pattern, Python `Thread.join(timeout)` wrapper, Java `ExecutorService`+`Future.get(timeout)`), and make the configured value the single source of truth.

### M-2 · Exposure dedup sets grow without bound in Node, Java, and Go

- **Node:** `ExposuresApi.seen` is never cleared, even on flush (`client.ts` lines 135, 152–156, 172–189 — flush drains `queue` but not `seen`).
- **Java:** `PostHogAdapter.exposureDedup` (`ConcurrentHashMap.newKeySet()`) only ever grows (`PostHogAdapter.java` lines 62, 255).
- **Go:** the exposure gate's `seen` map is never pruned (`adapters/posthog/posthog.go` line 110; `exposure.go`).
- **Contrast:** Python clears `_seen` on every flush (`client.py` lines 238–241).
- **Impact:** long-lived, high-cardinality services (one entry per distinct user × flag × value) leak memory; dedup semantics also silently diverge across languages (Node dedups forever; Python dedups per flush window).
- **Fix (owners: Agents F, H, I):** ratify one semantic (recommend Python's clear-on-flush, matching `ext-exposures-dedup`'s scope) and/or cap with an LRU.

### M-3 · Node telemetry attribute allowlist defaults to allow-all

- **Where:** `client.ts` lines 47–50 ("Undefined ⇒ all non-secret keys") and 207–213 — arbitrary signal attribute keys pass through with only value-pattern redaction.
- **Contrast:** Python and Go enforce hard-coded canonical allowlists unconditionally (`client.py` 40–58; `telemetry.go`); Java signals have a fixed field set.
- **Impact:** the documented design intent "telemetry has an allowlist" is not true by default in Node; callers can ship arbitrary PII in signal attributes without noticing.
- **Fix (owner: Agent F):** default `TelemetryPolicy.attributeAllowlist` to the canonical key set; keep the option for extension.

### M-4 · `fireweave.*` reserved-key carve-out diverges across languages (ruling 12)

- **Where:** Ledger ruling 12 ratifies `fireweave.groups` and `fireweave.groupProperties` as the only permitted `fireweave.*` context keys. **Python** implements the carve-out and adds an unratified third key `fireweave.evaluationContexts` (`context.py` lines 29–31). **Node** rejects all `fireweave.*` (`context.ts` lines 163–167), as do **Go** (`context.go` lines 152–156) and **Java** (`ContextValidator.java` lines 38–43); those three accept plain `groups`/`groupProperties` attribute spellings instead (`context.ts` 178–187; `posthog.go` 310–331; via the seam in Java).
- **Impact:** the same context is valid in Python and `InvalidContext` in the other three — a cross-language conformance and least-surprise problem rather than a direct vulnerability; also, Python's extra sanctioned key widens the reserved namespace without a ruling.
- **Fix (owner: orchestrator + Agents F, H, I or G):** either implement the ruling-12 carve-out in Node/Go/Java or amend the ruling to bless the plain-key spelling only; remove or ratify `fireweave.evaluationContexts`.

### M-5 · Python does not explicitly cap vendor retry behavior

- **Where:** `adapters/posthog.py` `_build_client` (lines 240–261) sets the flag-request timeout but, unlike Node (`featureFlagsRequestMaxRetries: 0`, `fetchRetryCount: 0` — `adapters/posthog.ts` 213–214) and Go (`FeatureFlagRequestMaxRetries: &retries` with default 0 — `posthog.go` 183–189), leaves posthog-python's internal retry/queue defaults untouched.
- **Impact:** retry amplification under backend brownout is bounded only by whatever the pinned vendor version does (posthog 7.31.0 defaults: bounded but non-zero capture retries, bounded 10 000-event queue). Not unbounded, but uncontrolled by us and divergent from the other languages.
- **Fix (owner: Agent G):** pass explicit retry/queue caps to the vendor client and record the effective values in `capabilities.get()`.

## LOW

### L-1 · Node context copy/merge assigns caller-controlled `__proto__` keys via bracket assignment

`deepCopyJson`/`normalizeContextInput`/`mergeContexts` do `out[k] = v` on plain objects (`context.ts` lines 56–63, 96–103, 120–122). There is **no** recursive merge into shared objects, so no global prototype pollution exists; but a JSON-borne own-property `"__proto__"` key silently becomes the copy's prototype instead of data (attribute vanishes from validation and serialization). Fix: create null-prototype objects (`Object.create(null)`) or skip `__proto__`/`constructor`/`prototype` keys.

### L-2 · Redaction patterns are case-sensitive in all four languages

`ph[cxs]_`, `Bearer` (Node `errors.ts` 72–77; Python `errors.py` 116–119; Go `errors.go` 152–157; Java `Redaction.java` 18–23). Real PostHog prefixes are lowercase, so exposure is minimal, but `bearer x`/`BEARER x` slip through. Fix: case-insensitive flags.

### L-3 · `http://` accepted for non-loopback hosts

All four config validators accept plain http for any allowlisted host (Node `runtime.ts` 67–69; Python `config.py` 58–60; Go `posthog.go` 133–136; Java accepts any parseable URI host, `FireweaveConfig.java` 78–91 — it does not even require http(s) scheme). Needed today only for the loopback test-server. Fix: require https unless the hostname is loopback; Java should additionally pin the scheme.

### L-4 · Node capabilities report a shutdown default (10 000 ms) that nothing implements

`client.ts` line 305 (`shutdownTimeoutMsDefault: 10000`) vs the hardcoded 2 000 ms in `adapters/posthog.ts` line 393. Misleading operational metadata; folds into the M-1 fix.

### L-5 · Python build artifacts tracked in git

`sdks/python/src/fireweave.egg-info/*` (PKG-INFO, SOURCES.txt, …) are committed. No secrets inside (verified), but generated files drift and add review noise. Fix: `git rm -r --cached` and add `*.egg-info/` to `.gitignore` (which already covers `dist/`, `.venv/`).

### L-6 · Default host allowlists differ between Go and Java

Go allows `us.posthog.com`, `eu.posthog.com`, `app.posthog.com`, `us.i.posthog.com`, `eu.i.posthog.com` + loopback (`posthog.go` 51–55); Java allows only `us.i.posthog.com`, `eu.i.posthog.com` + loopback (`FireweaveConfig.java` 19–20). Harmless asymmetry, but ratify one canonical list when fixing H-1 (recommend the `*.i.posthog.com` ingestion pair + loopback; the non-`i` hosts are UI hosts).

---

## Secure-default recommendations (priority order)

1. **Default-on host allowlist everywhere** (H-1) with one canonical list shared by all four languages (L-6), https-only for non-loopback (L-3).
2. **Fixed outward messages on every error path** — close the Node internal-error interpolation (H-2); redaction remains defense-in-depth, not the primary control.
3. **One enforced shutdown deadline sourced from config in every language** (M-1/L-4), using Go's bounded-race pattern as the reference implementation.
4. **Telemetry allowlist on by default in Node** (M-3) and ratified dedup lifecycle (clear-on-flush) for exposure sets (M-2).
5. **Explicit vendor retry/queue caps in Python** (M-5), mirrored into `capabilities.get()` so operators can audit effective bounds.

## Supply-chain requirements for Agent K's release pipeline (informative)

Current state: exact pins + lockfiles for Node (`package.json`/`package-lock.json`: posthog-node 5.46.1, @openfeature/server-sdk 1.22.0) and Go (`go.mod`/`go.sum`: posthog-go v1.22.0, go-sdk v1.17.2); exact `posthog==7.31.0` in `pyproject.toml` (no lockfile — core has zero runtime deps); Maven-exact `dev.openfeature:sdk 1.15.1`, `jackson-databind 2.17.1` (no PostHog artifact — ledger ruling 10). The pipeline should add:

- **SBOM** (CycloneDX or SPDX) per package per release, covering the optional PostHog extras.
- **Provenance/attestation:** SLSA build provenance (npm `--provenance`, PyPI Trusted Publishing attestations, Go module sum transparency via GOPROXY/sumdb, Maven GPG signing + Sigstore where supported).
- **Checksums** published alongside artifacts; verify vendor-dependency digests at build time (lockfile-only installs: `npm ci`, `pip install --require-hashes` via a constraints file — which also resolves the missing Python lock, `mvn -o` against a verified repo).
- **Update policy:** Renovate/Dependabot on the four vendor pins with security-advisory fast-path; jackson-databind and posthog-* should be tracked for CVEs explicitly since they parse untrusted network JSON.
- **CI secret scanning** (the `ph[cxs]_` history scan from this review, automated as a pre-merge gate) and the T12 no-disk-write guard from required-tests.md.
