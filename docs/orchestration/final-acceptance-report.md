# Fireweave Polyglot SDK — Phase 7 Final Acceptance Report

**Date:** 2026-07-27  
**Repo:** `/Users/niketh/Coding/fireweave-sdk/Untitled`  
**Verifier:** Phase 7 final acceptance agent  
**Scope:** Pre-release scaffolding acceptance (not public publish)  
**Commit policy:** report-only — no commit, no package publish

---

## Executive decision

**Selected architecture: Option 2 — OpenFeature provider + FireweaveClient sharing one runtime** ([ADR-0001](../adr/0001-sdk-architecture.md)).

Per ADR-0001, `FireweaveProvider` (OpenFeature) and `FireweaveClient` (extensions) share a single `FireweaveRuntime` that owns a `BackendAdapter` (phase one: `PostHogAdapter`; tests: `InMemoryAdapter`). Flag evaluation goes through OpenFeature; releases / exposures / signals / capabilities go through the client. Public types are Fireweave-owned; PostHog types stay quarantined in adapters.

**Why Option 2 (ADR-0001):**

- Matches internal ADR-017 thin-provider intent and the rollout-server OpenFeature harness.
- Uniform adapter pattern across Node / Python / Go / Java with one conformance fixture set.
- Rejects Option 1/3 (forfeit OF interoperability), Option 4 (official PostHog OF providers pre-1.0 / absent in Go/Java), and Option 5 (Fireweave remote eval service — out of phase-one scope).

Server-first scope is ratified in [ADR-0004](../adr/0004-server-first.md). PostHog wrap-vs-delegate rules live in [ADR-0002](../adr/0002-posthog-adapter.md); OF boundary in [ADR-0003](../adr/0003-openfeature-boundary.md).

**Phase 7 gate decision:** **GO for pre-release scaffolding** (tags, dry-run artifacts, CI, docs). **NO-GO for public registry publish** until company authorization + registry provisioning (see Release plan).

---

## Repository changes

Directory-by-directory summary of what exists in the monorepo:

| Path | Contents |
| --- | --- |
| `sdks/node/` | `@fireweaveai/sdk` workspace — runtime, OF provider, PostHog + in-memory adapters, unit/integration/conformance runners |
| `sdks/python/` | `fireweave` package — sync core + `fireweave.aio`, OF provider, adapters, pytest + conformance runner |
| `sdks/go/` | Module `github.com/FireWeave-HQ/fireweave-sdk/sdks/go` — `fireweave`, `openfeature`, adapters, conformance CLI |
| `sdks/java/` | Maven parent `ai.fireweave:fireweave-java-parent` — modules `fireweave-sdk`, `fireweave-openfeature`, `fireweave-adapter-posthog` (seam), `fireweave-testing` |
| `examples/{node,python,go,java}/` | Offline-by-default walkthroughs (OF + Fireweave extensions); exercised by `scripts/test-all.sh` |
| `spec/` | Canonical JSON schemas (v0.1.0): decision, context, errors, release-context, signal, capabilities, fireweave-sdk |
| `contracts/` | Shared fixtures: evaluation, context, lifecycle, faults, extensions, security + harness docs |
| `test-server/` | Zero-dep Node HTTP stub + fixtures for integration/fault re-runs |
| `tools/` | Conformance comparator (`tools/conformance/compare.mjs`), release changelog helper, Python lint baseline |
| `scripts/` | `test-all.sh`, `conformance-all.sh`, `build-all.sh` (dry-run packaging) |
| `docs/` | Architecture, ADRs, compatibility, privacy, security, research, reviews, orchestration ledger/verification |
| `.github/` | CI, security workflow, release workflow (**publish jobs `if: false`**), `RELEASE.md`, issue/PR templates |
| Root community | `README.md`, `LICENSE` (MIT), `CONTRIBUTING.md`, `GOVERNANCE.md`, `SECURITY.md`, `CODEOWNERS`, etc. |

---

## Package inventory

All packages are **unpublished**. Initial intended version **0.1.0** (Java currently builds as `0.1.0-SNAPSHOT` jars in dry-run).

| Ecosystem | Artifact | Intended registry | Status |
| --- | --- | --- | --- |
| Node | `@fireweaveai/sdk@0.1.0` (`fireweaveai-sdk-0.1.0.tgz`) | npmjs.com (`@fireweaveai` scope) | Dry-run pack only; name pending company ratification |
| Python | `fireweave==0.1.0` (sdist + wheel) | PyPI / TestPyPI | Dry-run build only; name reservation TBD |
| Go | module `github.com/FireWeave-HQ/fireweave-sdk/sdks/go` | proxy.golang.org via tag `sdks/go/v*` | Tag-gated; publish job hard-disabled |
| Java | `ai.fireweave:fireweave-sdk` | Maven Central (`ai.fireweave`) | Dry-run jars; **namespace verification pending** |
| Java | `ai.fireweave:fireweave-openfeature` | Maven Central | Dry-run |
| Java | `ai.fireweave:fireweave-adapter-posthog` | Maven Central | Dry-run; **PostHog seam-only** (no vendor server SDK dependency — ruling 10 / RB-3) |
| Java | `ai.fireweave:fireweave-testing` | Maven Central | Dry-run (InMemory + conformance helpers) |

Phase 7 dry-run artifacts (local `build/packages/`, gitignored): see Test report § Packaging.

---

## Compatibility matrix

Source of truth: [docs/compatibility.md](../compatibility.md). Pins below reflect that doc + orchestrator **ruling 10** (Java).

| | Node | Python | Go | Java |
| --- | --- | --- | --- | --- |
| **Language** | Node ≥ 20.20 | Python ≥ 3.10 | Go 1.25 | Java ≥ 11 |
| **OpenFeature SDK** | `@openfeature/server-sdk` 1.22.0 | `openfeature-sdk` ≥ 0.10, < 0.11 | `go-sdk` v1.17.2 | `dev.openfeature:sdk` **1.15.1** (ruling 10) |
| **PostHog SDK** | `posthog-node` 5.46.1 | `posthog` 7.31.0 (`[posthog]` extra) | `posthog-go` v1.22.0 | **none** — seam `PostHogClientApi` only |
| **Remote eval** | ✅ | ✅ | ✅ | ⚠️ injected seam only |
| **Local / local-only** | ✅ | ✅ | ✅ | ⏳ pending upstream server SDK |
| **Structured flags** | ✅ | ✅ | ✅ | ✅ |
| **Groups** | ✅ canonical + plain alias | ✅ | ✅ | ✅ builder + canonical/alias |
| **Payloads** | ✅ | ✅ | ✅ | ✅ |
| **Exposure events** | opt-in `sendExposure` (default false, ruling 20); vendor `$feature_flag_called` suppressed on local path | opt-in default false | opt-in default false | opt-in default false (aligned); Fireweave-owned via seam |
| **OF tracking (§6)** | ⏳ planned | ⏳ planned | ⏳ planned | ⏳ planned |
| **Fireweave extensions** | ✅ | ✅ | ✅ | ✅ |
| **Guardrails** | 🧪 stub | 🧪 stub | 🧪 stub | 🧪 stub |
| **Conformance (65)** | 63 + 2 skip | 65 | 65 | 64 + 1 skip |

**Known gaps (current):** Java PostHog unpublished; OF tracking deferred; guardrails stub; browser/mobile/edge deferred (ADR-0004); numeric skips (Node IEEE-754 / Java 32-bit int); release/signal delivery skew Node/Python vs Go/Java sink delivery — see Known limitations.

---

## Test report

Evidence from **this Phase 7 run** plus cited prior verification docs. **No invented results.**

### Commands run (Phase 7 final)

```bash
bash scripts/test-all.sh          # EXIT 0 — "All test steps passed."
bash scripts/conformance-all.sh   # EXIT 0 — 0 undeclared divergences
bash scripts/build-all.sh         # EXIT 0 — dry run; nothing published
```

Logs: `/tmp/fireweave-test-all-final.log`, `/tmp/fireweave-conformance-all-final.log`, `/tmp/fireweave-build-all-final.log`.

### Unit / language tests (`scripts/test-all.sh`)

| Surface | Result | Exact counts (this run) |
| --- | --- | --- |
| **Node** typecheck | PASS | `tsc` OK |
| **Node** unit | PASS | **89 / 89** (`node:test`) |
| **Node** integration | PASS | **16 / 16** (includes PostHog test-server + RB-1/RB-2 case) |
| **Python** ruff F-lint | PASS | 0 new / 0 baselined |
| **Python** pytest | PASS | **239 passed** in 0.76s |
| **Go** gofmt / vet / build | PASS | (gofmt green — Phase 6 residual closed) |
| **Go** `go test -race ./...` | PASS | 5 packages `ok`; verbose recount **75** `--- PASS` (no FAIL) |
| **Java** `mvn clean install` | PASS | Surefire reconfirm: sdk **65** + openfeature **8** + adapter-posthog **14** + testing **2** = **89** tests, 0 fail/error/skip |
| **Examples** (offline) | PASS | node / python / go / java all exit 0 |

**Phase 5 cite** ([phase5-verification.md](phase5-verification.md)): Node 85u+15i, Python 238, Go 74 PASS (+subtests), Java 86 — superseded upward by Phase 6/7 fixes (ruling 20, RB fixes, etc.).

**Phase 6 cite** ([phase6-verification.md](phase6-verification.md)): Node 89+16, Python 239, Java 86 then, conformance 65 / 0 divergences; only residual was gofmt + Java exposure default (both closed before/at Phase 7).

### Contract / conformance (`scripts/conformance-all.sh`)

| Language | pass | fail | skipped-with-documented-limitation |
| --- | ---: | ---: | ---: |
| node | 63 | 0 | 2 |
| python | 65 | 0 | 0 |
| go | 65 | 0 | 0 |
| java | 64 | 0 | 1 |

**Fixtures:** 65 · **Comparator:** `No undeclared divergence. All skips are fixture-declared with documented limitations.`

Declared skips: Node `eval-int-beyond-safe-integer`, `eval-numeric-coercion-int-float`; Java `eval-int-beyond-safe-integer`.

### Integration

Covered by Node integration suite (16) against `test-server/`, Java HTTP-stub fault note in surefire (`faults-via-http-stub: 8 pass over real HTTP`; `fault-stale-cache` adapter-simulated only), and offline examples in `test-all.sh`.

### Differential (comparator)

`tools/conformance/compare.mjs` — **0 undeclared divergences** (Phase 5, Phase 6, and this Phase 7 run).

### Security

- Fixture suite: 5 `contracts/security/sec-*` fixtures exercised inside the 65-fixture conformance matrix.
- CI workflow: `.github/workflows/security.yml` (gitleaks, dependency review, osv-scanner, license allowlist) — **not re-executed in this Phase 7 local run**; design + disposition evidence in `docs/security/*`.
- Agent J: **0 release blockers**, 2 HIGH now **Fixed** ([findings-disposition.md](../security/findings-disposition.md)).

### Packaging

`bash scripts/build-all.sh` **PASS** (dry-run). Artifacts + `SHA256SUMS` under `build/packages/`:

- `fireweaveai-sdk-0.1.0.tgz`
- `fireweave-0.1.0.tar.gz`, `fireweave-0.1.0-py3-none-any.whl`
- `fireweave-{sdk,openfeature,adapter-posthog,testing}-0.1.0-SNAPSHOT.jar`
- Go: `go build` + `go mod verify`

Publishing remains hard-disabled in `.github/workflows/release.yml` (`if: false`).

### Benchmarks

**Not established** — no benchmark suite was run in Phase 5, 6, or 7.

---

## Security report

### Threat model (summary)

[docs/security/threat-model.md](../security/threat-model.md) covers assets (API/secret keys, PII contexts, flag defs, telemetry, release IDs), trust boundaries (caller↔SDK, core↔vendor, SDK↔network, co-tenants), and risks R1–R8: secret leakage, PII in errors/telemetry, SSRF/egress, resource exhaustion, vendor type leak, concurrent context mixing, supply chain, and file-write surface.

Phase-one mitigations verified across languages include: secret redaction in errors, host allowlist default-on + https-off-loopback, context bounds pre-network, vendor quarantine tests, and fixed taxonomy messages on fault paths.

### Agent J findings disposition

| Severity | Original | Disposition at acceptance |
| --- | --- | --- |
| RELEASE BLOCKER | 0 | n/a |
| HIGH (J-H-1 host allowlist; J-H-2 Node Internal messages) | 2 | **Fixed** — [findings-disposition.md](../security/findings-disposition.md) |
| MEDIUM | 5 | Mostly fixed / residual tracked (shutdown deadline skew, LOW redaction case-sensitivity, hygiene) |
| LOW | 6 | Non-blocking residuals tracked |

### Agent M blockers closed

From [adversarial-review.md](../reviews/adversarial-review.md) + [phase6-verification.md](phase6-verification.md):

| ID | Topic | Status |
| --- | --- | --- |
| **RB-1** | Node hybrid/local success ≠ Network | **CLOSED** |
| **RB-2** | Local path suppresses vendor `$feature_flag_called` | **CLOSED** |
| **RB-3** | Java `create(config)` honest UnsupportedCapability + docs | **CLOSED** (seam-only) |
| Adv H-2…H-8 / J HIGHs | ULID, Flags().Evaluate, exposure defaults, pins, evaluationContexts, disposition | **CLOSED** (Java `sendExposure` default **false** per ruling 20 — verified in `EvaluationOptions.java`) |

---

## API examples

Smallest correct examples drawn from `examples/` (real APIs). Truncated for brevity; full files are executable offline.

### Node — OpenFeature

```js
import { OpenFeature } from '@openfeature/server-sdk';
import { FireweaveProvider, FireweaveRuntime, InMemoryAdapter } from '@fireweaveai/sdk';

const runtime = new FireweaveRuntime(new InMemoryAdapter({
  flags: { 'new-checkout': { type: 'boolean', enabled: true, value: true, variant: 'on' } },
}));
await OpenFeature.setProviderAndWait('checkout', new FireweaveProvider(runtime));
const flags = OpenFeature.getClient('checkout');
const enabled = await flags.getBooleanValue('new-checkout', false, {
  targetingKey: 'user_01HZXEXAMPLE0000000000001',
});
```

### Node — Fireweave extension

```js
import { FireweaveClient } from '@fireweaveai/sdk';
const fireweave = new FireweaveClient(runtime);
fireweave.releases.setContext({
  stampIds: ['stmp_01HZXEXAMPE000000000000001'],
  rolloutId: 'rollout_01HZXEXAMPE000000000000001',
  changeId: 'chg_01HZXEXAMPE000000000000001',
});
fireweave.signals.recordHealth({ name: 'checkout-api', status: 'healthy' });
```

Source: `examples/node/index.mjs`.

### Python — OpenFeature

```python
from openfeature import api
from openfeature.evaluation_context import EvaluationContext as OFContext
from fireweave import FireweaveRuntime, InMemoryAdapter
from fireweave.openfeature import FireweaveProvider

runtime = FireweaveRuntime(InMemoryAdapter(DEMO_FLAGS))
api.set_provider(FireweaveProvider(runtime))
of_client = api.get_client()
ctx = OFContext(targeting_key="user_42", attributes={"tier": "gold"})
enabled = of_client.get_boolean_value("new-checkout", False, ctx)
```

### Python — Fireweave extension

```python
from fireweave import FireweaveClient
fw = FireweaveClient(runtime)
fw.releases.set_context(
    rollout_id="rollout_01HZX3",
    change_id="chg_01HZXEX0000000000000000001",
    stamp_ids=["stmp_01HZXEX0000000000000000001"],
)
fw.signals.record_health("checkout-service", "ok", rollout_id="rollout_01HZX3")
```

Source: `examples/python/service.py`.

### Go — OpenFeature

```go
runtime := fireweave.NewRuntime(buildAdapter(), fireweave.Config{RequireTargetingKey: true})
client := fireweave.NewClient(runtime)
provider := fwprovider.NewProvider(client)
_ = of.SetProviderAndWait(provider)
ofClient := of.NewClient("example-app")
evalCtx := of.NewEvaluationContext("org_01HZXEXAMPLE0000000000001", map[string]any{"tier": "pro"})
enabled := ofClient.Boolean(ctx, "checkout-redesign", false, evalCtx)
```

### Go — Fireweave extension

```go
_ = client.Releases().SetContext(ctx, fireweave.ReleaseContext{
    RolloutID: "rollout_example_checkout_redesign",
    ChangeID:  "chg_01HZXEG0000000000000000001",
    StampIDs:  []string{"stmp_01HZXEG0000000000000000001"},
})
_ = client.Signals().RecordHealth(ctx, fireweave.HealthSignal{
    Name: "provider", Status: "ok", RolloutID: "rollout_example_checkout_redesign",
})
```

Source: `examples/go/main.go`.

### Java — OpenFeature

```java
FireweaveRuntime runtime = new FireweaveRuntime(config, new PostHogAdapter(new OfflinePostHogClient()));
FireweaveProvider provider = new FireweaveProvider(runtime);
OpenFeatureAPI.getInstance().setProviderAndWait("example", provider);
Client client = OpenFeatureAPI.getInstance().getClient("example");
MutableContext ctx = new MutableContext("org_01HZXEXAMPLE0000000000001");
boolean checkoutV2 = client.getBooleanValue("checkout-v2", false, ctx);
```

### Java — Fireweave extension

```java
FireweaveClient fireweave = new FireweaveClient(runtime);
fireweave.releases().setContext(ReleaseContext.builder()
    .stampId("stmp_01HZXEXAMP0E00000000000001")
    .rolloutId("rollout_example_1")
    .changeId("chg_01HZXEXAMP0E00000000000001")
    .build());
fireweave.signals().recordHealth("provider", "ok");
```

Source: `examples/java/.../ExampleApp.java`. Note: production Java PostHog requires an injected `PostHogClientApi`; `PostHogAdapter.create(config)` is unsupported until upstream publishes a server SDK.

---

## Known limitations

1. **Java PostHog unpublished** — `PostHogAdapter.create(config)` → `UnsupportedCapability`; production use needs injected `PostHogClientApi` or `InMemoryAdapter` (ruling 10 / RB-3).
2. **Numeric skips** — Node: IEEE-754 / single number resolver (2 fixtures); Java: OF 32-bit int range (1 fixture).
3. **`fault-stale-cache`** — Java (and local-eval staleness generally) may be adapter-simulated when definitions polling sits behind the seam; not all languages exercise live stale-definition HTTP the same way.
4. **Guardrails** — stub only (`UnsupportedCapability`); real evaluation deferred.
5. **OpenFeature tracking (§6)** — planned, not implemented.
6. **Browser / mobile / edge** — explicitly out of phase one (ADR-0004); no web SDK package.
7. **Release/signal sink skew** — Go/Java deliver more release/signal traffic to adapter sinks; Node/Python may keep some paths in-process — check `capabilities.get()`.
8. **Plain `groups` alias** — retained for phase one (ruling 19); removal backlog.
9. **`flags.evaluateMany` / `telemetry.configure`** — removed from architecture sketch; unimplemented backlog (ruling 16).
10. **Package names / license ratification** — working names; MIT in-repo; company ratification required before public publish (ADR-0001 § consequences / GOVERNANCE).
11. **Benchmarks** — not established.
12. **Signed release tags** — workflow pushes unsigned annotated tags today; owner re-signs locally ([RELEASE.md](../../.github/RELEASE.md)).

---

## Release plan

Cite: [`.github/RELEASE.md`](../../.github/RELEASE.md), [GOVERNANCE.md](../../GOVERNANCE.md).

| Item | Plan |
| --- | --- |
| **Initial version** | `0.1.0` per component |
| **Pre-release period** | Staging channels: npm dist-tag `next`; TestPyPI; Maven Central portal staging; Go `-rc.N` tags — **after** publish jobs are authorized |
| **Registries** | npm `@fireweaveai/sdk`; PyPI `fireweave`; Go module proxy via `sdks/go/v*`; Maven Central `ai.fireweave` |
| **Order** | One component per workflow_dispatch (`node` \| `python` \| `go` \| `java`); dry_run default `true` |
| **Rollback** | Prefer fix-forward (`x.y.z+1`); npm deprecate / PyPI yank / Maven immutable / Go `retract` — never reuse burned versions |
| **Maintainer responsibilities** | Per-area CODEOWNERS; cross-language API needs all four SDK maintainers; contracts via orchestrated review; **publication gated on explicit company authorization** |

### Emphasize

**NOTHING is published to npm / PyPI / Maven / the Go proxy without written release-owner authorization.** Every publish job in `release.yml` is `if: false`. Local and CI package steps are dry-run artifacts only.

Company provisioning still required (RELEASE.md): npm `@fireweaveai` org + OIDC trusted publisher; PyPI/TestPyPI name reserve + trusted publisher; Maven Central `ai.fireweave` DNS TXT + portal tokens + GPG; GitHub attestation settings; signed-tag identity; branch/tag protection.

---

## Follow-up backlog

Prioritized for post–0.1.0 / 1.0 planning:

| Priority | Item |
| --- | --- |
| P0 | Company: license/package-name ratification; provision npm/PyPI/Maven trusted publishing; enable publish jobs only after written auth |
| P0 | Bind Java PostHog when `com.posthog:posthog-server` (or equivalent) publishes with local eval |
| P1 | Browser SDK (`@openfeature/web-sdk` + `posthog-js`) — design from proprietary deploy-sdk web facade; never ship secret keys |
| P1 | Edge workers (secret-safe server patterns only) |
| P1 | Mobile (Android/iOS) — deferred with ADR-0004 |
| P1 | Real guardrails evaluation (replace stub) |
| P2 | OpenFeature tracking API (§6) |
| P2 | Fireweave remote evaluation adapter / service (ADR-0001 Option 5) |
| P2 | OTel hooks / rollout semconv parity with internal deploy-sdk |
| P2 | `flags.evaluateMany`, `telemetry.configure` (ruling 16 backlog) |
| P2 | Remove plain `groups`/`groupProperties` alias (ruling 19) |
| P3 | Benchmark suite + perf budgets |
| P3 | Residual security LOWs (case-insensitive redaction, `__proto__` hardening, egg-info hygiene) |
| P3 | Equalize vendor exposure LRU / capture-queue semantics across languages |
| P3 | Bot GPG / gitsign for signed tags in CI |

---

## Phase 7 verdict

| Question | Answer |
| --- | --- |
| Final verification green? | **YES** — test-all, conformance-all, build-all all exit 0 |
| Architecture accepted? | **YES** — Option 2 / ADR-0001 |
| Agent M RBs closed? | **YES** |
| Agent J HIGHs closed? | **YES** |
| **GO / NO-GO (pre-release scaffolding)** | **GO** |
| **GO / NO-GO (public npm/PyPI/Maven publish)** | **NO-GO** — company decisions + registry provisioning outstanding |

---

*End of Phase 7 final acceptance report.*
