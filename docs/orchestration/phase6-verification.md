# Phase 6 Verification (post blocker / HIGH fix wave)

**Date:** 2026-07-28 (local re-verify)  
**Repo:** `/Users/niketh/Coding/fireweave-sdk/Untitled`  
**Scope:** Re-run matrix after Phase 6 RB/HIGH fixes; spot-check RB-1/RB-2/RB-3 + ruling 20.  
**Commit:** not created (verify-only; working tree may contain mid-run Node exposure-default edits).

---

## Verdict

**CONDITIONAL GO for Phase 7 acceptance.**

| Gate | Status |
| --- | --- |
| Release blockers RB-1 / RB-2 / RB-3 | **CLOSED** (code + docs honesty for RB-3) |
| Agent J HIGHs (J-H-1, J-H-2) | **CLOSED** (see `docs/security/findings-disposition.md`) |
| Adversarial HIGHs claimed in Phase 6 wave | **CLOSED in code** for H-2/H-3/H-5/H-6/H-7/H-8; **H-4 residual on Java** (`sendExposure` default still `true`) |
| Ruling 20 (evaluate exposure default false) | **PASS** Node / Python / Go; **FAIL** Java default still `true` |
| `scripts/test-all.sh` | **FAIL** — only `gofmt` on `sdks/go/fireweave/client.go` (alignment whitespace); all language tests + examples passed |
| `scripts/conformance-all.sh` | **PASS** — 65 fixtures, **0 undeclared divergences** |

Phase 7 should not treat the suite as fully green until `gofmt` is fixed (one alignment hunk). Functional blockers are closed.

---

## 1. Unit / language matrix (`bash scripts/test-all.sh`)

**Overall exit:** 1 (`FAIL  go: gofmt`)

| Language / step | Result | Real numbers |
| --- | --- | --- |
| **Node** typecheck | PASS | `tsc` OK |
| **Node** unit | PASS | **89 / 89** |
| **Node** integration | PASS | **16 / 16** |
| **Python** ruff F-lint | PASS | 0 new / 0 baselined |
| **Python** pytest | PASS | **239 passed** in 0.85s |
| **Go** gofmt | **FAIL** | `fireweave/client.go` — map-literal key alignment only (`intSafeMaxAbs` / `shutdownTimeoutMsDefault`) |
| **Go** vet / build / `test -race` | PASS | packages OK (cached) |
| **Java** `mvn clean install` | PASS | (includes unit + conformance gate) |
| **Examples** node/python/go/java offline | PASS | all four shut down cleanly |

**Node re-check after mid-run ruling-20 landing:** re-ran `npm run test` under `sdks/node` → unit **89/89**, integration **16/16**, including `H-4: evaluate does not emit by default; sendExposure:true opts in with dedup` and `RB-1/RB-2: hybrid local eval…`.

---

## 2. Conformance matrix (`bash scripts/conformance-all.sh`)

**Overall:** PASS (exit 0)  
**Fixtures:** **65**  
**Comparator:** `No undeclared divergence. All skips are fixture-declared with documented limitations.`

| Language | pass | fail | skipped-with-documented-limitation |
| --- | ---: | ---: | ---: |
| node | 63 | 0 | 2 |
| python | 65 | 0 | 0 |
| go | 65 | 0 | 0 |
| java | 64 | 0 | 1 |

Declared skips (unchanged): Node `eval-int-beyond-safe-integer` + `eval-numeric-coercion-int-float`; Java `eval-int-beyond-safe-integer`.

---

## 3. Release blockers — code spot-check

### RB-1 · Node hybrid/local success ≠ Network — **CLOSED**

**Evidence:** `sdks/node/packages/sdk/src/adapters/posthog.ts`

- When hybrid (`!localOnly`) and no `/flags` observation, adapter calls `canServeFromLocalSnapshot()`; if true, returns `fromSnapshot(...)` instead of throwing `Network`.
- `canServeFromLocalSnapshot()` is true when `secretApiKey` is set, definitions loaded, or `isLocalEvaluationReady()`.
- Unit: `RB-1: hybrid local serve without /flags observation is a Decision, not Network`.
- Integration: `RB-1/RB-2: hybrid local eval succeeds without /flags…`.

### RB-2 · Local path avoids getFlag / suppresses vendor `$feature_flag_called` — **CLOSED**

**Evidence:** same adapter

- Header contract: local snapshot from `_flags` — never `getFlag` / `isEnabled`.
- `fromSnapshot`: if `_flags` missing → `{ found: false }` rather than calling `getFlag`.
- Owned clients wrap `capture` to drop `$feature_flag_called` unless `fireweave.exposure === true`.
- Unit: `RB-2: local snapshot path does not emit vendor $feature_flag_called`.

### RB-3 · Java `create(config)` UnsupportedCapability + docs honesty — **CLOSED**

**Evidence:**

- `PostHogAdapter.create(FireweaveConfig)` throws `FireweaveException(ErrorKind.UnsupportedCapability, …)` with explicit “no published PostHog server SDK” message (`sdks/java/fireweave-adapter-posthog/.../PostHogAdapter.java`).
- Docs: `docs/posthog.md` (Java “Not production-ready (seam only)”), `docs/compatibility.md` row + known gap #1, `docs/quickstart.md`, ADR-0002 superseded pin for `posthog-server` 2.9.0, `sdks/java/README.md`.

---

## 4. Ruling 20 — evaluate exposure default false

| Language | Default | Evidence | Status |
| --- | --- | --- | --- |
| **Node** | **false** (opt-in) | `runtime.ts`: emit only when `options.sendExposure === true`; test asserts zero exposures by default | **PASS** |
| **Python** | **false** | `client.py` / `runtime.EvaluationOptions`: `send_exposure: bool = False` | **PASS** |
| **Go** | **false** | `SendExposureEvents bool` zero-value; comments + `ResolveRequest.SendExposure *bool` override | **PASS** |
| **Java** | **true** | `EvaluationOptions.Builder`: `private boolean sendExposure = true`; runtime honors opt-out | **FAIL / residual** |

Ruling 20 text targets Node alignment with Python/Go. Java remains on ADR §6/§23 “OF path side-effectful” default — not a reopen of RB-1/RB-2, but **not** portable side-effect-free evaluate.

---

## 5. HIGH closure summary (for Phase 7)

| ID | Topic | Verified status |
| --- | --- | --- |
| J-H-1 | Host allowlist default-on | Fixed (disposition + Node H-1 tests) |
| J-H-2 | Node Internal message hygiene | Fixed (disposition + runtime test) |
| Adv H-2 | Node stamp/change ULID | Fixed (`STAMP_ID_RE` in `client.ts`) |
| Adv H-3 | Go public `Flags().Evaluate` | Fixed (`client.go`) |
| Adv H-4 | Exposure defaults | Py/Go/Node aligned to false; **Java still true** |
| Adv H-5 / H-6 | ADR pins / 65-fixture counts | ADR errata + compatibility “65 fixtures” |
| Adv H-7 | Java `evaluationContexts` | Removed from `EvaluationContext.java` (no matches) |
| Adv H-8 | Disposition table | `docs/security/findings-disposition.md` present |

**Docs lag (non-blocking for RB gate, fix before publish):** `docs/compatibility.md` “Known gaps” items 2–4 still describe RB-1/RB-2, Node ULID, and Java evaluationContexts as open — contradict current code.

---

## 6. Phase 7 go / no-go

| Question | Answer |
| --- | --- |
| Blockers closed? | **Yes** — RB-1, RB-2, RB-3 |
| HIGHs closed? | **Mostly yes** — Agent J HIGHs closed; adversarial wave closed except **Java ruling-20 / H-4 default** and **stale compatibility known-gaps** |
| Ready for Phase 7 acceptance? | **CONDITIONAL GO** — proceed after (1) `gofmt` on `sdks/go/fireweave/client.go`, (2) decide Java `sendExposure` default vs ruling 20, (3) scrub stale known-gaps in `compatibility.md` |

**Recommended Phase 7 entry checklist**

1. `gofmt -w sdks/go/fireweave/client.go` → re-run `bash scripts/test-all.sh` (expect exit 0).
2. Ratify Java evaluate default (`false` for ruling 20 portability, or explicit “Java OF-default true” exception).
3. Update `docs/compatibility.md` known gaps to match closed RB-1/RB-2 / H-2 / H-7.
