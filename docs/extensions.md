# Fireweave extension APIs

Everything in this document is a **[Fireweave extension]** — functionality beyond the OpenFeature specification, exposed on `FireweaveClient`, which shares the same runtime as the OpenFeature provider. You can use only OpenFeature, only `FireweaveClient`, or both at once; no extension requires hooks or affects standard flag evaluation (ADR-0003).

The canonical capability names (identical across languages, discoverable via `capabilities.get`):

```
releases.setContext  releases.start  releases.complete  releases.fail
exposures.record     exposures.flush
signals.recordHealth signals.recordError signals.recordMetric signals.recordOutcome
capabilities.get
```

Extension calls **degrade instead of throwing**: failures come back as result objects (Node/Python/Java) or typed `error` values (Go) carrying the canonical error kind ([concepts.md](concepts.md#error-taxonomy)).

Constructing the client (it wraps the same runtime as your provider):

```js
const fireweave = new FireweaveClient(runtime);            // Node
```
```python
fw = FireweaveClient(runtime)                              # Python
```
```go
client := fireweave.NewClient(runtime)                     // Go (facades: client.Flags(), client.Releases(), …)
```
```java
FireweaveClient fireweave = new FireweaveClient(runtime);  // Java (facades: fireweave.releases(), …)
```

> **Release context portability.** Pass a `rolloutId` **and** 1–64 unique well-formed `stampIds` (`stmp_<26 Crockford ULID>`), with optional `changeId` (`chg_<26 Crockford ULID>`), matching `spec/release-context.schema.json`. All four languages enforce the patterns (adversarial H-2 closed).

## Flags (Fireweave-native Decision API)

Detailed evaluation without OpenFeature, on the client surface (ruling 16 / architecture §6.3):

```python
# Python
d = fw.flags.evaluate("new-checkout", FlagType.BOOLEAN, False, EvaluationContext("user_42"))
# alias: fw.flags.get_details(...)
```

```go
// Go — prefer Flags().Evaluate over Runtime().Evaluate
d := client.Flags().Evaluate(ctx, "new-checkout", fireweave.FlagTypeBoolean, false,
    fireweave.EvaluationContext{TargetingKey: "user_42"}, fireweave.EvaluateOptions{})
```

```java
// Java
Decision d = fireweave.evaluate(...);
```

```js
// Node — prefer FireweaveClient Decision API when present (ruling 16);
// until landed, detailed eval may still go through runtime.evaluate.
```

Phase-one evaluate defaults are **side-effect-free** for exposures; use `exposures.*` (or Go `SendExposureEvents` / `EvaluateOptions.SendExposure`) when you need `$feature_flag_called`.

## Releases

Bind the process to a rollout identity (typed IDs from `spec/release-context.schema.json`: `rolloutId`, `chg_…` change IDs, `stmp_…` stamp IDs), then report lifecycle transitions. Deploy-attestation ("boot beacon") semantics are carried by `setContext` + `start`.

```js
// Node — setContext takes a ReleaseContext object.
const res = fireweave.releases.setContext({
  rolloutId: 'rollout_01HZXEXAMPLE000000000001',
  changeId: 'chg_01HZXEXAMPLE0000000000001',
  stampIds: ['stmp_01HZXEXAMPLE000000000001'],
});
fireweave.releases.start();                       // {ok, status: 'in_progress'}
fireweave.releases.complete();                    // records an outcome signal too
fireweave.releases.fail({ reason: 'canary regression' });  // reason is secret-redacted
```

```python
# Python — keyword / positional args; stamp_ids validated against the schema.
fw.releases.set_context(
    "rollout_01HZXEXAMPLE000000000001",
    change_id="chg_01HZXEXAMPLE0000000000001",
    stamp_ids=["stmp_01HZXEXAMPLE000000000001"],
)
fw.releases.start()
fw.releases.complete()
fw.releases.fail(reason="canary regression")
```

```go
// Go — every call takes a context.Context; transitions name the rollout explicitly.
rc := fireweave.ReleaseContext{
    RolloutID: "rollout_01HZXEXAMPLE000000000001",
    ChangeID:  "chg_01HZXEXAMPLE0000000000001",
    StampIDs:  []string{"stmp_01HZXEXAMPLE000000000001"},
}
err := client.Releases().SetContext(ctx, rc)
err = client.Releases().Start(ctx, rc.RolloutID)
err = client.Releases().Complete(ctx, rc.RolloutID)
err = client.Releases().Fail(ctx, rc.RolloutID, "canary regression")
```

```java
// Java — builder for the context; transitions name the rollout explicitly.
fireweave.releases().setContext(ReleaseContext.builder()
    .rolloutId("rollout_01HZXEXAMPLE000000000001")
    .changeId("chg_01HZXEXAMPLE0000000000001")
    .stampId("stmp_01HZXEXAMPLE000000000001")
    .build());
fireweave.releases().start("rollout_01HZXEXAMPLE000000000001");
fireweave.releases().complete("rollout_01HZXEXAMPLE000000000001");
fireweave.releases().fail("rollout_01HZXEXAMPLE000000000001", "canary regression");
```

Failure reasons pass the secret-redaction filter before being stored or emitted (`phc_`/`phs_`/`phx_` keys, bearer tokens → `[REDACTED]`).

Where a vendor adapter is attached, Go emits release transitions as `$fw_release_<status>` telemetry events; other languages record them through the adapter signal sink — `FireweaveRemoteAdapter` batches them to `POST /v1/capture` (see [compatibility.md](compatibility.md#known-gaps)).

## Exposures

Explicit exposure recording, for the rare cases where the evaluation-path exposure policy isn't enough (e.g. you evaluated once and served many users, or you need `rolloutId` correlation). Records are queued in-process, deduplicated on `(targetingKey, flagKey, variant, value)`, and drained by `flush`. Dedup windows clear on flush (clear-on-flush lifecycle).

```js
// Node
fireweave.exposures.record({ targetingKey: 'user_42', flagKey: 'new-checkout', value: true, variant: 'on' });
await fireweave.exposures.flush();                 // {ok, flushed, queued}
```

```python
# Python
fw.exposures.record("user_42", "new-checkout", "on", True)   # (targeting_key, flag_key, variant, value)
fw.exposures.flush()                               # FlushResult(ok, flushed, queued)
```

```go
// Go
res, err := client.Exposures().Record(ctx, fireweave.Exposure{
    TargetingKey: "user_42", FlagKey: "new-checkout", Variant: "on", Value: true,
})
flushed, err := client.Exposures().Flush(ctx)      // count of exposures delivered
```

```java
// Java
fireweave.exposures().record(exposure);            // ExtensionResult<RecordOutcome>
fireweave.exposures().flush();                     // ExtensionResult<FlushOutcome>
```

Duplicates are acknowledged (`ok`, `deduped: true`) but not re-queued. Flushed exposures are delivered through the adapter telemetry sink — `POST /v1/capture` on `FireweaveRemoteAdapter`; on the in-memory adapter they are captured for test assertions. `FireweaveClient.shutdown()` (Node/Python) flushes the queue first; Go and Java require an explicit `Flush()`/`flush()` before shutdown if you want queued exposures delivered.

## Signals

Release-safety telemetry: component health, error observations, guard metrics, and release outcomes (`spec/signal.schema.json`, kinds `health | error | metric | outcome`). Messages are secret-redacted; attributes pass a telemetry allowlist so arbitrary PII doesn't go on the wire.

```js
// Node — object envelopes (kind is filled in by the method).
fireweave.signals.recordHealth({ name: 'checkout-api', status: 'healthy' });
fireweave.signals.recordError({ name: 'checkout-api', errorKind: 'Timeout', message: '...' });
fireweave.signals.recordMetric({ name: 'p99_latency_ms', value: 187 });
fireweave.signals.recordOutcome({ name: 'release', status: 'completed', rolloutId: '...' });
```

```python
# Python — keyword arguments.
fw.signals.record_health("checkout-api", "healthy", rollout_id="rollout_01HZXEXAMPLE000000000001")
fw.signals.record_error("checkout-api", error_kind="Timeout", message="...")
fw.signals.record_metric("p99_latency_ms", 187.0, unit="ms")
fw.signals.record_outcome("release", "completed", rollout_id="rollout_01HZXEXAMPLE000000000001")
```

```go
// Go — typed structs per kind.
err := client.Signals().RecordHealth(ctx, fireweave.HealthSignal{Name: "checkout-api", Status: "ok"})
err = client.Signals().RecordError(ctx, fireweave.ErrorSignal{Name: "checkout-api", ErrorKind: fireweave.KindTimeout, Message: "..."})
err = client.Signals().RecordMetric(ctx, fireweave.MetricSignal{Name: "p99_latency_ms", Value: 187})
err = client.Signals().RecordOutcome(ctx, fireweave.OutcomeSignal{Name: "release", Status: "completed"})
```

```java
// Java — convenience overloads plus a full-envelope record(Signal).
fireweave.signals().recordHealth("checkout-api", "ok");
fireweave.signals().recordError("checkout-api", ErrorKind.Timeout, "...");
fireweave.signals().recordMetric("p99_latency_ms", JsonValue.of(187));
fireweave.signals().recordOutcome("release", "completed");
fireweave.signals().record(Signal.builder(Signal.Kind.HEALTH, "checkout-api")
    .status("ok").rolloutId("rollout_…").build());
```

Correlation fields (`rolloutId`, `changeId`, `stampId`, `flagKey`, `variant`) tie signals back to the bound release. Delivery: Go and Java hand signals to the adapter's telemetry sink immediately; Node and Python record in-process (retrievable for tests via `getRecorded()` / `signals.recorded`) unless a sink is attached.

## Guardrails

**[Experimental — phase-one stub.]** The guardrails facade exists with stable types, but every operation degrades with `UnsupportedCapability` (never throws/panics). Server-side ramp control remains a Fireweave-platform concern in phase one.

```js
fireweave.guardrails.evaluate('ramp-gate');   // { ok: false, degraded: true, errorKind: 'UnsupportedCapability' }
```

The static capability matrix reports `guardrails: false`.

## Capabilities

Discover what this SDK build and the attached adapter can do — used by harness tooling, useful for defensive feature-gating in your own code.

All four languages return the **structured** matrix (`spec/capabilities.schema.json`: `static` ∪ `runtime`). Name-list sugar is also available where useful.

```js
// Node — full matrix.
const caps = fireweave.capabilities.get();
// caps.static.features  { flags: true, releases: true, …, guardrails: false }
// caps.runtime.backend  'fireweave' | 'inmemory' | 'none' | 'other'
// caps.runtime.features { localEvaluation: true, sideEffectFreeReads: true, … }
fireweave.capabilities.list();   // canonical operation-name list
```

```python
fw.capabilities.get()            # structured static/runtime matrix (ruling 18)
fw.capabilities.names()          # canonical operation-name list
fw.capabilities.invoke("releases.start")   # dynamic dispatch; degrades on unknown names
```

```go
client.Capabilities().Get()         // structured Capabilities matrix
client.Capabilities().Operations()  // []string of operation names
```

```java
Capabilities caps = fireweave.capabilities().get();  // names + static/runtime feature maps
caps.names();  // sugar
```

Unknown capability names passed to the dynamic dispatchers (`invokeCapability` / `capabilities.invoke` / `Capabilities().Invoke`) degrade with `UnsupportedCapability` — they never throw.

## Lifecycle interaction

Extension calls are gated on runtime state in **all four languages** (ruling 17): before `READY` they fail/degrade with `NotReady` / `UnsupportedCapability`; after shutdown with `AlreadyClosed`. All extension state (release context, exposure queue, recorded signals) is per-`FireweaveClient`-instance in Node/Python/Java and per-`Client` in Go — construct one client and share it.
