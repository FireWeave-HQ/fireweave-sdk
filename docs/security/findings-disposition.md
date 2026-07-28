# Security findings disposition (Agent J → Phase 5 / Agent M)

**Status:** Disposition published 2026-07-27 so Agent J HIGH exit criteria are auditable.  
**Sources:** [release-blockers.md](release-blockers.md) (Agent J original findings), [threat-model.md](threat-model.md), [required-tests.md](required-tests.md), adversarial review H-8.  
**Rule:** HIGH must be Fixed (or Residual with explicit waiver) before final acceptance.

## Agent J HIGH

| ID | Title | Disposition | Evidence |
|---|---|---|---|
| **J-H-1** | Host allowlist off by default (Node/Python) | **Fixed** | Canonical `DEFAULT_ALLOWED_HOSTS` / `defaultAllowedHosts` in Node, Python, Go, Java; https required for non-loopback. Python: `sdks/python/src/fireweave/config.py` (`DEFAULT_ALLOWED_HOSTS`, validate path). Fixture `sec-endpoint-ssrf-allowlist` + Python `test_lifecycle.py` default-deny cases. |
| **J-H-2** | Node interpolates vendor/internal errors into outward message | **Fixed** (Node path) | Non-Fireweave wrap uses taxonomy `Internal` message; vendor text on `cause` only. Adversarial review “What held up” table confirms. Residual: do not regress in Node `runtime` / adapter error mapping. |

## Agent J MEDIUM (Phase 5 progress)

| ID | Title | Disposition | Evidence |
|---|---|---|---|
| **J-M-1** | Shutdown timeouts unenforced | **Mostly fixed / residual** | Configured deadline wired in languages that ship it; Go `DefaultCloseTimeout` aligned to **10s** matching `shutdownTimeoutMsDefault: 10000`. Spot-check per language before publish. |
| **J-M-2** | Exposure dedup unbounded | **Fixed** (clear-on-flush) | Node/Python/Go/Java flush paths clear seen-sets; fixture `ext-exposures-dedup`. |
| **J-M-3** | Node telemetry allowlist allow-all | **Fixed** (Node) | `DEFAULT_SIGNAL_ATTRIBUTE_ALLOWLIST` default-on (adversarial “What held up”). |
| **J-M-4** | `fireweave.*` carve-out divergence | **Fixed** | Rulings 12–14: `fireweave.groups` / `fireweave.groupProperties` accepted in all four; fixture `ctx-fireweave-groups-carveout`. Python extra `fireweave.evaluationContexts` removed/rejected (ruling 13). |
| **J-M-5** | Python vendor retry/queue uncapped | **Fixed** | Explicit caps + capabilities mirror (`vendorRetriesDisabled`, `boundedTelemetryQueue`) in `sdks/python/src/fireweave/adapters/posthog.py`. |

## Agent J LOW (non-blocking; track)

| ID | Disposition | Notes |
|---|---|---|
| J-L-1 Node `__proto__` copy | **Residual** | Prefer `Object.create(null)` / key skip (adversarial M-4). |
| J-L-2 Case-sensitive redaction | **Residual** | Bearer/key patterns should be case-insensitive (adversarial M-5). |
| J-L-3 http for non-loopback | **Mostly fixed** | https-only for non-loopback enforced where Phase 5 landed; keep fixture coverage. |
| J-L-4 Node shutdown default mismatch | **Residual / fold into J-M-1** | Capabilities vs hard-coded adapter deadline. |
| J-L-5 Python egg-info in git | **Residual** | Hygiene. |
| J-L-6 Allowlist host-set skew Go vs Java | **Fixed intent** | Canonical five PostHog hosts + loopback shared; verify Java list matches. |

## Adversarial Agent M HIGH (security-adjacent process)

| ID | Disposition | Owner |
|---|---|---|
| **M-H-8** | **Fixed** by this document | Docs / process |
| **M-H-1** | **Fixed** — user-facing docs rewritten against Phase 5 code | Docs |
| Remaining M HIGH (RB-*, H-2 Node, H-7 Java) | See [adversarial-review.md](../reviews/adversarial-review.md); Node/Java code owned by sibling agents |

## Gate statement

Agent J’s two HIGH findings (host allowlist default-on; Node Internal message hygiene) are **Fixed** in code. Security reviewers should treat [release-blockers.md](release-blockers.md) historical “open HIGH” text as **superseded** by this disposition table. New release blockers from the adversarial review (RB-1/RB-2 Node, RB-3 Java) are product/functional, tracked separately — they do not reopen J-H-1/J-H-2.
