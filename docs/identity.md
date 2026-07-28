# Identity: targeting keys, anonymous users, groups

## targetingKey → distinct_id

The OpenFeature `targetingKey` **is** the cohort key, and on PostHog-backed evaluation it maps **1:1** to the PostHog `distinct_id`. This is the single identity join point between your app, flag targeting, and PostHog analytics — the same value that keys percentage rollouts also keys the `person` your exposure events attach to.

```js
await client.getBooleanValue('new-checkout', false, { targetingKey: 'user_42' });
```

Two hard rules (ADR-0001 §8):

1. **Fireweave never auto-generates an identity.** If no `targetingKey` is supplied, the SDK does not invent a per-evaluation anonymous ID (which would make every percentage rollout a coin flip per call and pollute PostHog with junk persons). Identity is caller-owned.
2. **Missing `targetingKey` fails safe.** PostHog-backed evaluation without a targeting key returns your **default value** with `errorCode = TARGETING_KEY_MISSING` (Fireweave kind `InvalidContext`). With the in-memory adapter, keyless evaluation of unconditional flags is allowed unless you opt into strictness.

Opt into strictness so missing identity is caught uniformly, even in tests:

```js
new FireweaveRuntime(adapter, { requireTargetingKey: true })       // Node
```
```python
FireweaveConfig(require_targeting_key=True)                        # Python
```
```go
fireweave.Config{RequireTargetingKey: true}                        // Go
```
```java
FireweaveConfig.builder().requireTargetingKey(true).build()        // Java
```

> **Note:** `requireTargetingKey` defaults to **false** in all four languages (opt-in). Javadoc or examples that call it "the default" are wrong — identity strictness is always explicit.

## Choosing a stable key

Percentage rollouts are computed by hashing `(flag, targetingKey)` — the key must be **stable across requests** or users flip between variants.

| Situation | Use |
| --- | --- |
| Logged-in user | Your durable user ID (`user_42`) |
| B2B / org-level ramps | The **org ID** (`org_123`) so a whole organization flips together ("sticky" org ramps). Everyone in the org shares one cohort assignment |
| Anonymous visitor | A generated ID that you **persist** (server-set cookie / session record) and reuse on every subsequent request — generate once, store, resend |
| Batch / worker jobs | A stable job- or tenant-scoped identifier, not a per-run UUID |

Anti-patterns: fresh UUID per request (non-sticky, junk persons), request IDs, timestamps, or anything PII-bearing you would not send to your analytics backend (the key is stored by PostHog as `distinct_id`; prefer opaque IDs over email addresses).

If your frontend already uses PostHog (`posthog-js`), reuse its `distinct_id` server-side so flags and analytics agree on who the user is.

## Person properties

Non-reserved context attributes become PostHog `person_properties` for targeting condition matching:

```python
EvaluationContext("user_42", {"plan": "enterprise", "region": "eu"})
```

They are sent to the backend for evaluation — treat them with the same PII care as analytics properties ([privacy docs](privacy.md); context bounds in [openfeature.md](openfeature.md#evaluation-context)). Attributes with a `$` prefix are passed through as PostHog system directives (e.g. `$process_person_profile`), not person properties.

## Groups

PostHog [group analytics](https://posthog.com/docs/product-analytics/group-analytics) **[PostHog-specific]** lets flags target group-level entities (company, project) rather than persons. Fireweave carries group membership and group properties in the evaluation context and maps them to PostHog `groups` / `group_properties`.

**Canonical spelling (all languages, rulings 12–14):** reserved keys `fireweave.groups` and `fireweave.groupProperties`. **Plain alias (ruling 19):** `groups` / `groupProperties` are also accepted. Prefer the canonical keys in portable code; when both are present, the canonical keys win.

```js
// Node — canonical keys (plain `groups` / `groupProperties` also accepted).
await client.getBooleanValue('org-flag', false, {
  targetingKey: 'user_42',
  'fireweave.groups': { company: 'org_123' },
  'fireweave.groupProperties': { company: { plan: 'enterprise' } },
});
```

```python
# Python — canonical keys (plain `groups` / `groupProperties` also accepted).
EvaluationContext("user_42", {
    "fireweave.groups": {"company": "org_123"},
    "fireweave.groupProperties": {"company": {"plan": "enterprise"}},
})
```

```go
// Go — canonical helpers / attribute keys (plain alias also accepted).
of.NewEvaluationContext("user_42", map[string]any{
    "fireweave.groups":          map[string]any{"company": "org_123"},
    "fireweave.groupProperties": map[string]any{"company": map[string]any{"plan": "enterprise"}},
})
```

```java
// Java — first-class builder API (also accepts canonical attribute keys).
EvaluationContext ctx = EvaluationContext.builder()
    .targetingKey("user_42")
    .group("company", "org_123")
    .build();
```

Group **identify** (creating/updating group profiles) is not an evaluation side effect and is not part of the phase-one extension surface — do it with your PostHog analytics SDK.

## Reserved keys

`targetingKey`, `kind`, and the `fireweave.*` namespace are reserved in the evaluation context. Per the ratified spec rule, `fireweave.groups` and `fireweave.groupProperties` are the only permitted `fireweave.*` keys; anything else `fireweave.*`-prefixed is rejected with `INVALID_CONTEXT`. Don't name your own attributes after any of these. (`fireweave.evaluationContexts` was **rejected** — ruling 13.)
