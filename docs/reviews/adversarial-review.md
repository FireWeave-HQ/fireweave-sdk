# Fireweave Polyglot SDK — Adversarial Review (Agent M)

**Date:** 2026-07-27  
**Reviewer posture:** skeptical external maintainer  
**Scope:** `docs/architecture.md`, ADRs 0001–0004, orchestration ledger (rulings 1–19), security/privacy docs, `spec/`, `contracts/`, `sdks/{node,python,go,java}/`, `examples/`  
**Method:** attempt to disprove stated guarantees with code evidence  
**Constraint:** review document only — no SDK code changes, no commits  

---

## Executive summary

Phase 5 fixed Agent J’s HIGH security items (host allowlist default-on, Node fixed Internal messages) and landed most rulings 13–18 in code. That progress is real. It does **not** make the polyglot surface ready for a first public pre-release.

Three release blockers remain: (1) Node hybrid/local PostHog evaluation is logically broken and mis-documented on exposure side effects; (2) Java cannot bind a real PostHog server SDK (`PostHogAdapter.create` always fails); (3) user-facing docs (`compatibility.md`, `identity.md`, `extensions.md`, Agent J security docs) still describe pre–Phase-5 gaps as current truth, so adopters will follow wrong APIs.

**Verdict: NO-GO** for first public pre-release.

Counts: **3 RELEASE BLOCKER · 8 HIGH · 9 MEDIUM · 7 LOW · 5 FUTURE**

---

## What held up under pressure

These claims are largely true in code (with caveats noted later):

| Claim | Verdict |
|---|---|
| OpenFeature provider present in all four languages; never-throw getters on OF path | Holds (provider wrappers + runtime error→default) |
| No PostHog types in core public entrypoints | Holds for Node main export, Python core, Go `fireweave/`, Java `fireweave-sdk` (adapter seams are intentional) |
| Canonical host allowlist default-on (H-1) | Holds — identical five PostHog hosts + loopback in all four |
| Node Internal vendor-text interpolation (H-2) | Holds for non-Fireweave wrap path (`new FireweaveError('Internal', { cause })`) |
| `fireweave.groups` / `fireweave.groupProperties` carve-out (rulings 12–14) | Holds in validators across four languages; fixture `ctx-fireweave-groups-carveout` exists |
| Extension lifecycle gating (ruling 17) | Holds in Node/Python/Go/Java client gates + `ext-lifecycle-gating` |
| `capabilities.get` structured matrix (ruling 18) | Holds (Java also exposes flat `names()` sugar) |
| Clear-on-flush exposure dedup (M-2) | Holds where implemented (Node/Python/Go/Java flush paths) |
| Shutdown timeout wired from config (M-1) | Largely holds (Go still defaults 5s close vs 10s capability const) |
| Telemetry allowlist default-on in Node (M-3) | Holds (`DEFAULT_SIGNAL_ATTRIBUTE_ALLOWLIST`) |
| Python vendor retry/queue caps (M-5) | Holds (`feature_flags_request_max_retries` / `max_retries` / `max_queue_size`) |
| Defaults never throw on OF evaluation | Holds |
| Packages unpublished; publish hard-disabled | Holds (appropriate for pre-release) |

---

## Release blocker

### RB-1 · Node PostHog hybrid/local evaluation treats successful local serves as `Network`

- **Evidence:** `sdks/node/packages/sdk/src/adapters/posthog.ts` lines 263–314. When `onlyEvaluateLocally` is false (ADR-0002 **Local** mode: local eval + remote fallback), any `evaluateFlags` result that did not produce an HTTP observation throws `Network`:

```294:298:sdks/node/packages/sdk/src/adapters/posthog.ts
    if (!localOnly) {
      if (observation === undefined) {
        // No request observed and not local eval — treat as network failure (offline).
        throw new FireweaveError('Network');
      }
```

  With `secretApiKey` set, posthog-node can satisfy flags from the definitions poller without calling `/flags`. That is the intended local path — and Fireweave classifies it as a transport failure. Unit tests only exercise `onlyEvaluateLocally: true` with a fake client (`posthog-adapter.test.ts` ~220–243), mocking away the hybrid path.

- **Impact:** Documented local / hybrid evaluation (ADR-0002, `docs/posthog.md`, architecture lifecycle) does not work on Node. Callers get defaults + `Network` / `GENERAL` instead of local decisions. This is a functional hole in a primary phase-one mode, not a polish issue.

- **Recommended fix:** If a snapshot contains the flag (or local evaluation is enabled and ready), prefer `fromSnapshot` when no HTTP observation exists; reserve `Network` for remote-only mode or explicit transport failure. Add an integration test: secret key + local definitions, no `/flags` hit → successful decision.

### RB-2 · Node claims vendor `$feature_flag_called` is disabled; local snapshot reads always emit it

- **Evidence:**
  - Adapter docs claim side-effect-free reads (`posthog.ts` lines 7–9).
  - Client construction never sets `sendFeatureFlagEvent: false` (`posthog.ts` ~226–233).
  - Local path calls `snapshot.getFlag` (`fromSnapshot`, lines 350–355).
  - Upstream `posthog-node` `FeatureFlagEvaluations.getFlag` → `_recordAccess` → `_host.captureFlagCalledEventIfNeeded` → unconditional `capture({ event: '$feature_flag_called' })` (`node_modules/posthog-node/dist/feature-flag-evaluations.js` 50–56, 112–143; `client.js` 771–787). That path does **not** honor `sendFeatureFlagEvent`.
  - Privacy matrix claims Node vendor implicit exposure is “disabled” (`docs/privacy.md` §2 table).

- **Impact:** Local evaluation silently emits analytics side effects; `sendExposure: false` / Fireweave exposure policy cannot suppress them. Combined with Fireweave `exposures.record`, double exposure is possible. Side-effect-controlled evaluation (ADR-0001 §23) is falsified for the Node local path.

- **Recommended fix:** Prefer reading flag records without calling emitting accessors (mirror Python’s internal-record read), or intercept/drop `$feature_flag_called` that lack a Fireweave arming token (Go’s gate pattern). Update privacy/posthog docs to match reality until fixed. Add a test that asserts zero `$feature_flag_called` captures on local eval when exposure policy is off.

### RB-3 · Java PostHog adapter cannot be constructed for production use

- **Evidence:** `PostHogAdapter.create(FireweaveConfig)` always throws `UnsupportedCapability` (`sdks/java/fireweave-adapter-posthog/.../PostHogAdapter.java` lines 80–88). Ledger ruling 10 + `docs/posthog.md` document that `com.posthog:posthog-server` is unpublished. `capabilities.get` hard-codes `posthogAdapter: false` (`FireweaveClient.java` ~442) even when a seam client is injected. Architecture still lists Java PostHog via `com.posthog:posthog-server` (`docs/architecture.md` §4). ADR-0002 still pins `posthog-server` **2.9.0**.

- **Impact:** One of four advertised languages has no usable official PostHog backend. “Polyglot PostHog SDK” is false for Java without a custom `PostHogClientApi` implementation (HTTP client reinvented by every adopter). Examples only run via an offline stub (`examples/java/.../ExampleApp.java`).

- **Recommended fix (product choice, pick one before tagging a public pre-release):**
  1. **Honest packaging:** mark Java PostHog as `experimental` / omit from “supported backends” until upstream publishes; ship InMemory + OF only as GA surface; or
  2. **Interim binding:** implement a thin HTTP `/flags` client behind the existing seam (still no AGPL, no legacy 1.x), with clear capability flags; or
  3. **Delay public pre-release** until `posthog-server` exists and is wired.

---

## High

### H-1 · User-facing docs contradict Phase 5 code (rulings 14–18)

- **Evidence:** `docs/compatibility.md` “Known gaps” (lines 50–58) still claims: only Python accepts `fireweave.groups`; Node detailed eval requires `runtime.evaluate`; `capabilities.get` shape diverges; Node/Python lack extension gating; release `setContext` requirements differ. Code and fixtures contradict all of these (carve-out validators, `client.flags.evaluate`, structured capabilities, lifecycle gates, ruling-15 validators in Python/Go/Java). `docs/identity.md` §Groups still shows per-language spelling divergence as current. `docs/extensions.md` line 31 repeats stale setContext requirements. Agent J artifacts (`docs/security/release-blockers.md`, `threat-model.md`, `required-tests.md` T5/T6) still describe H-1/M-4 as open.

- **Impact:** Adopters following docs will write non-portable or unnecessarily forked code; security reviewers will chase already-fixed issues; trust in the doc set collapses.

- **Recommended fix:** Rewrite compatibility/identity/extensions known-gaps against current code; add a Phase-5 “security findings disposition” section that marks H-1/H-2/M-* fixed or residual; stop treating research ADRs as live pins without errata.

### H-2 · Ruling 15 incomplete on Node: `releases.setContext` does not validate stamp/change ULID patterns

- **Evidence:** Node checks only non-empty `rolloutId` + non-empty `stampIds` array (`client.ts` 117–126). Python (`client.py` `_validate_release_context` + `_STAMP_ID_RE`), Go (`validateReleaseContext` + `stampIDPattern`), and Java (`ReleaseContext.validate` + `STAMP_ID_PATTERN`) enforce `stmp_<26 Crockford>` and changeId patterns. Node unit test accepts invalid prefix `stamp_…` as `ok: true` (`client.test.ts` 19–23). Spec: `spec/release-context.schema.json` required + patterns.

- **Impact:** Cross-language attestation contexts that pass Node fail elsewhere (or worse: Node binds garbage IDs that other services reject). Ruling 15 is not met.

- **Recommended fix:** Port Python/Go regex + uniqueness/maxItems checks to Node; change the unit test to reject `stamp_` / malformed ULIDs; add a negative conformance case if fixtures don’t already cover malformed stamps.

### H-3 · Ruling 16 incomplete on Go: no Decision-returning API on the public `Client` surface

- **Evidence:** `fireweave.Client` exposes Releases/Exposures/Signals/Capabilities/Guardrails and `Runtime()` (`client.go` ~175–180, 220+) but **no** `Evaluate` / `Flags().Evaluate`. Detailed evaluation requires `client.Runtime().Evaluate(...)` — the reach-into-runtime pattern ruling 16 forbade for Node and required every language to avoid. Architecture §6.3 (behavioral requirement). Docs still excuse this (`compatibility.md` gap #3).

- **Impact:** Portable “FireweaveClient-only” detailed evaluation is impossible in Go without depending on runtime internals.

- **Recommended fix:** Add idiomatic `Client` method (e.g. `Flags().Evaluate` / `EvaluateDetailed`) delegating to `Runtime.Evaluate`, with `sendExposure`/payload options; document it; add a unit test that never names `Runtime()` in the call site.

### H-4 · Exposure emission defaults and OF-path side effects are inconsistent with ADR and across languages

- **Evidence:**
  - ADR-0001 §6/§23: OF default path is side-effectful (exposure on); opt-out for pure reads.
  - Go: `SendExposureEvents` defaults **false** (`posthog.go` 108–110); gate suppresses unless armed.
  - Node remote: no vendor emit (body parse); local: always emits (RB-2); Fireweave explicit exposures are separate.
  - Python: reads internal snapshot records — no vendor emit; exposures only via `send_exposures`.
  - Java: `EvaluationOptions.sendExposure` defaults true (`EvaluationOptions.java` 41) but `FireweaveRuntime` never calls `deliverExposure` on evaluate — dead option; OF path never emits.
  - Capability `exposureEmission: true` on Node/Python/Java adapters overstates OF-path behavior.

- **Impact:** Experiment exposure analytics silently missing or unexpectedly present depending on language/mode. “Default send” is not a shared contract.

- **Recommended fix:** Ratify one default (recommend: OF path emits once, opt-out via `sendExposure: false` / Go config). Wire Java `sendExposure`; align Go default with the ratification; make capabilities report actual OF-path behavior; add a cross-language fixture that asserts exposure count on evaluate.

### H-5 · Stale ADRs still publish wrong Java pins (OF 1.21.0, posthog-server 2.9.0)

- **Evidence:** ADR-0003 line 52 pins Java OF **1.21.0** (does not exist; ruling 10 → 1.15.1). ADR-0002 line 37 pins `posthog-server` **2.9.0**. Research docs still assert Maven Central presence. Live docs (`compatibility.md`, `openfeature.md`) are corrected; ADRs are not.

- **Impact:** External readers treating ADRs as source of truth will chase nonexistent artifacts; Agent C’s false research becomes rediscovered “bugs.”

- **Recommended fix:** ADR amendments / “Superseded pins” errata blocks pointing at ruling 10; never leave contradictory pins without a status line.

### H-6 · `docs/compatibility.md` conformance counts stale (63 vs 65 fixtures)

- **Evidence:** Ledger/canon agent: fixture inventory **65** (incl. carve-out + lifecycle gating). `compatibility.md` still says “63 fixtures” and Node 61/63. Java test asserts 65 (`ConformanceTest.java` ~53).

- **Impact:** Release communications and CI expectations drift; skips/pass rates misreported.

- **Recommended fix:** Regenerate matrix from latest conformance reports; document skip IDs explicitly.

### H-7 · Java public `EvaluationContext` still models unratified `evaluationContexts` tags

- **Evidence:** First-class field + builder `evaluationContext(String)` (`EvaluationContext.java` 36–47, 75–77, 219–224) serializes into `reserved.evaluationContexts`. Ruling 13 rejected Python’s `fireweave.evaluationContexts` attribute key; Java attribute path rejects `fireweave.evaluationContexts`, but the builder API reintroduces the same concept under a different spelling. Javadoc still markets “evaluation-context tags” as reserved extensions (lines 18–20).

- **Impact:** Cross-language context portability hole; future PostHog `evaluation_contexts` wiring could land in Java only.

- **Recommended fix:** Remove builder API and field for phase one, or gate behind experimental + ruling; ensure adapter never forwards the field until ratified.

### H-8 · Agent J HIGH items fixed in code but security gate docs still open — disposition missing

- **Evidence:** Code has `DEFAULT_ALLOWED_HOSTS` + https-off-loopback in Node/Python/Go/Java; Node Internal wrap uses taxonomy message. `docs/security/release-blockers.md` still lists H-1/H-2 as open HIGH with old line references. Project policy: HIGH must be fixed before final acceptance — without a disposition table, the gate is ambiguous.

- **Impact:** Process failure: cannot tell reviewers whether security exit criteria passed.

- **Recommended fix:** Publish `docs/security/findings-disposition.md` (or amend release-blockers) marking each J finding Fixed / Residual / Deferred with file evidence.

---

## Medium

### M-1 · Node host allowlist matching is case-sensitive; others lowercase

- **Evidence:** Node compares `url.hostname === h` (`hosts.ts` 59–63). Python lowercases (`config.py` 79–91). Go uses `EqualFold` (`posthog.go` ~179). Java normalizes to lower case (`FireweaveConfig.java` 119–128).

- **Impact:** `https://US.i.posthog.com` may pass Python/Go/Java and fail Node (or the reverse depending on allowlist entry casing).

- **Recommended fix:** Lowercase both sides in Node `assertHostAllowed`.

### M-2 · Go default close timeout 5s vs advertised 10s capability constant

- **Evidence:** `DefaultCloseTimeout = 5 * time.Second` (`posthog.go` 64–67); capabilities schema / runners expect `shutdownTimeoutMsDefault: 10000`.

- **Impact:** Operators trusting capabilities metadata misconfigure SLOs; shutdown may abort earlier than documented.

- **Recommended fix:** Align Go default to 10s or report the effective adapter default in capabilities.

### M-3 · Silent degradation / swallowed errors on telemetry paths

- **Evidence:** Node `flush`/`shutdown` catch-and-ignore (`posthog.ts` 405–409, 443–445). Python `_deliver` / `_capture` swallow all exceptions (`client.py` 200–202; `posthog.py` 382–391). Extension “success” can mean “accepted in-process, never delivered.”

- **Impact:** Release/exposure signals disappear without `ok: false`; hard to debug production attest gaps.

- **Recommended fix:** Return degraded results on sink failure where the fixture model allows; at minimum metrics/log hooks (opt-in) when delivery fails.

### M-4 · Node `deepCopyJson` still assigns `__proto__` via bracket write (J L-1 residual)

- **Evidence:** `context.ts` 67–71 `out[k] = deepCopyJson(v)` on plain `{}`.

- **Impact:** Attribute named `__proto__` can vanish / alter prototype of the copy; validation/serialization skew (not classic global pollution, still footgun).

- **Recommended fix:** `Object.create(null)` or skip `__proto__`/`constructor`/`prototype`.

### M-5 · Redaction patterns remain case-sensitive (J L-2 residual)

- **Evidence:** `Bearer` patterns in Node/Python/Go/Java redactors; no `i` flag.

- **Impact:** `bearer` / `BEARER` tokens can leak into signals/error strings.

- **Recommended fix:** Case-insensitive matching for bearer and key prefixes.

### M-6 · Java `requireTargetingKey` default false; Javadoc claims it is the default

- **Evidence:** `FireweaveConfig.Builder` field defaults to Java `false` (`FireweaveConfig.java` ~220). `EvaluationContext` javadoc says targeting key is required “when the runtime is configured with `requireTargetingKey`, **the default**” (`EvaluationContext.java` 14–16) — false. All languages default require-targeting to false unless set (Node `?? false`, Python `False`, Go zero-value false).

- **Impact:** Identity guarantee is opt-in; docs oversell strictness. InMemory allows keyless eval; PostHog adapters then fail at distinct_id.

- **Recommended fix:** Fix javadoc; consider default-on `requireTargetingKey` for PostHog-backed runtimes only, with fixture updates.

### M-7 · Release/signal delivery still uneven (Node releases in-process only)

- **Evidence:** Node `releases.setContext` mutates local state only (`client.ts` 124–126) — no adapter `deliver_release` hook (unlike Python `_deliver` / Go `emit`). Signals do call `recordSignal` when present. Docs partially acknowledge this but understate after ruling 17 (“delivered to the adapter sink”).

- **Impact:** Go release telemetry appears in PostHog; Node does not — cross-language attest observability diverges.

- **Recommended fix:** Add Node/Java release sink parity or document as an intentional, tested capability flag (`runtime.features.attest`).

### M-8 · `sendExposure` option missing or dead outside Java’s unused flag

- **Evidence:** Python `EvaluationOptions` only has `include_payload` (`runtime.py` 65–71). Node `EvaluateOptions` has `includePayload` but no `sendExposure` (`runtime.ts` ~53–55). Java has the flag but runtime ignores it (H-4).

- **Impact:** Architecture’s side-effect control API does not exist portably.

- **Recommended fix:** Add the option everywhere and wire adapters; conformance case for `sendExposure: false`.

### M-9 · Tests that mock away PostHog meaning (local/hybrid)

- **Evidence:** Node local tests inject `fakeClient` + `onlyEvaluateLocally: true` only; no test covers secret-key hybrid without HTTP observation (RB-1). Java PostHog tests are 100% seam fakes — acceptable for unit tests, but there is no contract test that a real `/flags` client would satisfy beyond the HTTP stub suite.

- **Impact:** False confidence in “PostHog adapter green.”

- **Recommended fix:** Mandatory integration cases listed under RB-1/RB-2; Java HTTP-stub suite already helps — keep it in CI default path.

---

## Low

### L-1 · Plain `groups` / `groupProperties` alias retained (ruling 19) without uniform docs

- **Evidence:** Code accepts alias in all four; `identity.md` still implies Node/Go are alias-only.

- **Impact:** Doc confusion; acceptable per ruling 19 backlog.

- **Recommended fix:** Document canonical-first + alias in one shared snippet.

### L-2 · Error kind skew on release validation (`InvalidContext` vs `Configuration`)

- **Evidence:** Node/Java often `InvalidContext`; Python/Go often `Configuration` for the same schema failure.

- **Impact:** Portable error handling brittle.

- **Recommended fix:** Ratify one kind for release-context schema failures (prefer `Configuration` or `InvalidContext` consistently).

### L-3 · ADR-0002 still lists `fireweave.evaluationContexts` mapping

- **Evidence:** ADR-0002 context table line 89; contradicted by ruling 13.

- **Impact:** Implementers may re-add the rejected key.

- **Recommended fix:** Strike or mark rejected.

### L-4 · Node `PostHogClientLike` exported via `@fireweaveai/sdk/posthog` subpath

- **Evidence:** `package.json` exports `./posthog`; interface is structural (not a vendor type import) — acceptable, but name is vendor-branded in the public subpath.

- **Impact:** Mild backend-independence optics issue, not a type leak.

- **Recommended fix:** Rename to `FlagsBackendClient` (breaking, 0.x OK) or document as adapter-only advanced API.

### L-5 · Capabilities `posthogAdapter: false` on Java even with injected PostHog adapter

- **Evidence:** Hard-coded false (`FireweaveClient.java` 442).

- **Impact:** Capability negotiation lies.

- **Recommended fix:** True when adapter name is `posthog` / seam present; false only when unbound.

### L-6 · Example / doc stamp IDs sometimes use non-schema lengths or prefixes

- **Evidence:** Node test `stamp_` prefix; various example ULIDs should be mechanically checked against schema.

- **Impact:** Copy-paste failures across languages.

- **Recommended fix:** Shared fixture IDs in examples; schema validate in example CI.

### L-7 · Package usability: path installs + Go `replace`, unpublished registries

- **Evidence:** `docs/quickstart.md`, `docs/versioning.md` — expected for pre-release.

- **Impact:** Not a defect for pre-release; becomes a blocker only if tagging “public” without registry artifacts.

- **Recommended fix:** Keep “unpublished” banner; don’t claim install-from-npm/PyPI/Maven until real.

---

## Future improvement

### F-1 · Guardrails remain UnsupportedCapability stubs everywhere  
Ship local evaluate or remove from capability names until real.

### F-2 · OpenFeature tracking (§6) unimplemented  
Keep experimental quarantine; don’t advertise.

### F-3 · SSRF allowlist encoding bypasses (J required-tests T6)  
Add cases for decimal/hex IP literals and IPv6-mapped forms.

### F-4 · Batch `flags.evaluateMany` / `telemetry.configure`  
Already backlog per ruling 16 — keep out of 0.1.

### F-5 · Supply-chain SBOM / provenance / pip hash pins  
Agent J informative requirements — needed before registry publish, not before source tag if publish stays disabled.

---

## Claim-by-claim disproof notes

| Claim under test | Result |
|---|---|
| OpenFeature compatibility | **Mostly holds.** Providers implement typed resolvers + lifecycle. Residual: numeric skips (Node/Java), no tracking, Python OF pre-1.0. |
| Backend independence / no PostHog types in public APIs | **Holds** for core packages. Adapter packages/subpaths intentionally vendor-adjacent; Java seam is Fireweave-owned. |
| Cross-language consistency (rulings 11–19) | **Partially disproved.** Carve-out + gating + capabilities largely aligned; ruling 15 (Node), 16 (Go), exposure defaults, release delivery, docs lag. |
| Thread safety / shutdown | **Mostly holds.** Go race-tested; Java/Node/Python shutdown deadlines largely wired. Residual: Go 5s vs 10s; swallowed shutdown errors. |
| Fallback behavior (defaults never throw) | **Holds** on OF/runtime evaluate paths. Extension APIs degrade with results/errors (ruling 17). |
| Secret safety / PII redaction | **Mostly holds** after H-2 fix. Residual: case-sensitive redaction; context PII still forwarded by design. |
| Deterministic tests | **Mostly holds** (InMemory + fixtures). **Disproved** for Node local/hybrid PostHog (mocked away — RB-1). |
| Semver / package usability | **Holds for 0.1.0 unpublished.** Not installable from registries; path/`replace` UX is honest in quickstart. |
| Documentation accuracy vs real APIs | **Disproved** for compatibility/identity/extensions/security disposition (H-1). |

---

## Go / no-go recommendation

### NO-GO for first public pre-release

Ship a **private/internal source tag** if needed, but do **not** announce a public pre-release until at least:

1. **RB-1** Node hybrid/local evaluation fixed + integration-tested.  
2. **RB-2** Node local exposure side effects controlled + privacy docs corrected.  
3. **RB-3** Java PostHog story is either real (HTTP seam or upstream SDK) or explicitly **non-goals** in all top-level docs/READMEs/architecture.  
4. **H-1 / H-2 / H-3 / H-4** closed or explicitly waived with customer-visible caveats.  
5. Security findings disposition published so Agent J HIGH exit criteria is auditable.

Until then, the strongest accurate statement is: *four OpenFeature-compatible server SDKs with a shared contract suite; PostHog production-ready on Node (remote-only), Python, and Go; Java PostHog seam-only; documentation not yet trustworthy as a portability guide.*
