# ADR-0009: A browser SDK for control points

- **Status:** Accepted
- **Date:** 2026-08-09
- **Scope:** `sdks/web` (the package published as `@fireweaveai/web-sdk`)
- **Supersedes:** the *Browser package* row in [ADR-0004](0004-server-first.md)'s "Future work" table
- **Related:** ADR-0003 (OpenFeature boundary), ADR-0005 (Fireweave proxy backend), ADR-0007 (control-point vocabulary), ADR-0008 (multi-runtime support)

## Context and Problem Statement

[ADR-0004](0004-server-first.md) made phase one server-only and put browsers explicitly out of scope. Its reasoning was not "browsers are unimportant" — it was that **local evaluation requires secret keys**, that a browser package would invite those keys into frontend bundles, and that four server languages already stretched phase-one capacity. It named a follow-up: *"Browser package — design reference: deploy-sdk `flags/web`; new MIT implementation under OF web SDK; remote-only; no secret keys."*

Two things have changed since.

1. **The secret-key hazard is gone from the architecture, not merely managed.** [ADR-0005](0005-fireweave-proxy-backend.md) made fw-server the evaluation backend, and [ADR-0006](0006-node-drops-direct-posthog-adapter.md) removed the direct vendor adapter from the Node package entirely. There is no longer a code path in this repo that wants a `phs_`/`phx_` key. A browser package no longer has to *avoid* local evaluation — local evaluation does not exist here to avoid.
2. **Web apps are the surface with no answer.** The rollout harness scaffolds a `web` surface today, and it binds a proprietary provider from `@fireweaveai/deploy-sdk/flags/web`. Server apps get an MIT, OpenFeature-standard, vendor-neutral SDK; browser apps get a closed one. That asymmetry is not a security posture, it is a gap.

## Decision

**Ship `@fireweaveai/web-sdk`: a browser SDK for control-point evaluation, remote-only, holding no secrets.**

It lives at `sdks/web`, as a peer of `sdks/node` rather than a subpath of it. The split is by **surface**, not by runtime — `sdks/node` is the server-runtime JS SDK (Node, Bun, Deno per ADR-0008); `sdks/web` is the browser JS SDK. Drawing the boundary at the surface puts it in exactly the same place ADR-0004 drew its security boundary, so the packaging expresses the security model instead of cutting across it.

It is a **clean-room implementation under MIT**, written against `spec/remote-protocol.md` and the OpenFeature web specification. deploy-sdk's `flags/web` is a design reference in the sense ADR-0004 intended — a description of the problem, not a source of code.

### Architecture

The same layering as the server SDK, with one boundary moved:

```
async   adapter.prefetch(ctx, flagKeys?)  → POST /v1/flags/evaluate → cache
async   runtime.initialize() | setContext() | registerTarget() | flush()
sync    runtime.evaluateSync(key, type, default) → Decision      ← cache read
sync    provider.resolve*Evaluation(...)         → ResolutionDetails
```

OpenFeature web providers resolve **synchronously**; this repo's architecture is async. The tension resolves at the runtime, not at the provider: the adapter prefetches a decision cache asynchronously, and evaluation is a pure synchronous read of it. `FireweaveWebProvider` therefore satisfies the web provider contract without the layering having to change shape.

`FireweaveWebClient` mirrors `FireweaveClient` — `controlPoints`, `exposures`, `signals`, `releases`, `capabilities`, and the `guardrails` stub — so the extension surface does not fork by surface. The one intentional divergence: `controlPoints.*` is **synchronous** here and promise-returning on the server. That follows from the OpenFeature web contract and is recorded in `docs/compatibility.md` as a difference, not a gap.

### Security rules

These are structural, not policy — each is enforced by a guard test, because a rule that depends on reviewer vigilance is a rule that eventually fails.

1. **Remote-only, permanently.** `features().localEvaluation` is `false` and there is no code path that could make it true. No definition polling, no in-process rule evaluation — so nothing in the package ever wants a secret key.
2. **No vendor SDK.** No `posthog-js` dependency; no handling of `phc_`/`phs_`/`phx_` key shapes.
3. **No environment access.** The package never reads `process`, `import.meta.env`, or `Deno.env`. Credentials arrive as explicit constructor options. The embedding app decides what to bake into its bundle; the SDK never reaches out and picks something up implicitly.
4. **https off-loopback**, with host pinning on the same `assertHostAllowed` semantics as the server SDK.
5. **Browser globals only** — no `process`, no `Deno`, no `node:` imports. This is the mirror image of ADR-0008's `runtime-portability.test.ts`, and is enforced the same way: a static check over `src/`.

### Conformance

A **separate** `contracts/web/` suite rather than the shared 65. The shared fixtures encode async server semantics — lifecycle gating around awaited evaluation, fault behaviour on a per-call round trip — and a synchronous cache-read surface does not answer the same questions. Forcing web through them would mean a wall of pre-declared skips that assert nothing.

The web suite covers what is genuinely web: prefetch-on-initialize, synchronous read, context-change re-prefetch and `ConfigurationChanged`, stale-on-timeout, the fault taxonomy, exposure flush on `pagehide`, and the security rules above.

## Two consequences we are choosing deliberately

### The public credential is now load-bearing

The browser authenticates with a build-baked project key. That key is public by construction — anything in a JS bundle is readable — so **the key is the entire authorization boundary** for browser evaluation.

Today that key is the same `project-api-key_…` family as deploy-beacon attest, carrying `attest:write`. That was defensible when it only ever sat on a server. It is not defensible baked into every customer's frontend bundle.

**A scoped `fw_public_…` key family, limited to `flags:evaluate` + `events:write`, is required platform work.** It is named here rather than left implicit, because shipping this SDK without it means shipping a documented, MIT-licensed, well-lit path to publishing an over-scoped credential. Per-key rate limiting belongs in the same change: once any origin can call the endpoint, quota exhaustion is the cheapest attack available.

### CORS becomes a platform property

Browser evaluation arrives from origins fw-server cannot enumerate, so the control-point routes accept any origin. This does not weaken a boundary — those routes are Bearer-authed and ignore cookies, so origin was never protecting them, and a hostile page gains nothing it could not already do with `curl`. It does, however, mean the previous paragraph is the *only* remaining control. The two decisions are coupled and should be read together.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **`@fireweaveai/sdk/web` subpath** | Shares core code and one release train, but puts server and browser builds in one package whose peer dependencies then contradict each other (`@openfeature/server-sdk` vs `web-sdk`), and blurs exactly the boundary ADR-0004 drew |
| **Keep browsers on the proprietary deploy-sdk** | The status quo. Leaves the one surface most exposed to key handling as the one surface with no open, auditable implementation |
| **Server-side BFF only; no browser package** | Legitimate and still the recommended pattern where a same-origin backend exists. But it is not available to static/JAMstack frontends, and declining to ship an SDK does not stop people writing worse ad-hoc versions of one |
| **Reuse the shared 65 conformance fixtures** | They encode async semantics; the honest result is a wall of skips. A skip that asserts nothing is worse than an absent fixture, because it looks like coverage |

## Consequences

- **Positive:** the browser surface gets the same OpenFeature-standard, vendor-neutral, auditable treatment as the server; the harness's `web` surface stops depending on a proprietary provider for control-point evaluation; the secret-key boundary that motivated ADR-0004 is now enforced by guard tests rather than by scope.
- **Negative:** a second package to version, publish, and keep in conformance; a second architecture-shaped test suite; and a real security dependency on key scoping that did not previously block anything.
- **Neutral:** ADR-0004 stands as written for everything else it decided. Mobile, edge, and Dart remain out of scope; this ADR retires exactly one row of its future-work table. *(Dart has since been brought into scope by [ADR-0011](0011-dart-control-points.md), which reuses this ADR's prefetch-plus-synchronous-read seam for Flutter.)*
