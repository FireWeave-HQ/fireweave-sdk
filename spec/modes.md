# Modes — local and remote

- **Status:** Normative for SDK v1
- **Applies to:** every language SDK in `sdks/`
- **Related:** `control-points.md`, `remote-protocol.md`, `start-profile.md` (the opt-in layer
  that resolves mode and credentials by rule)

An SDK instance runs in exactly one **mode**, fixed at initialisation. The mode selects the
adapter; nothing downstream branches on it.

## `mode` is required and never inferred

```
initFireweave({ mode: 'remote', apiKey, apiUrl })
initFireweave({ mode: 'local',  local: { controlPoints: { … } } })
```

`mode` MUST be a required option. An SDK MUST NOT infer it — in particular it MUST NOT fall
back to local mode when credentials are absent.

**Why this is a hard rule.** With inference, a missing or mistyped credential in production
silently becomes local evaluation: every control point serves its seeded or caller default,
nothing raises, and the boot log is green. The observable symptom is a feature that never
ramps, which is indistinguishable from a rollout nobody started. Requiring `mode` makes that
state unreachable by accident — `remote` without credentials is a boot error, and `local` in
production is something a human typed.

## Behaviour per mode

| | `local` | `remote` |
| --- | --- | --- |
| adapter | local, seeded map | remote, `POST /v1/control-points/evaluate` |
| network | none | fw-server |
| required options | `local.controlPoints` (may be empty) | `apiKey`, `apiUrl` |
| unknown key | `default`, `reason: DEFAULT` | `default`, `reason: ERROR`, `ControlPointNotFound` |
| `registerTarget` | **recorded in-process + traced** — nothing sent | `POST /v1/targets/register` |

Both modes expose the identical nine methods with identical signatures. A call site MUST NOT
need to know which mode it is running under.

## `registerTarget` in local mode

The local adapter MUST record the target in-process and MUST emit one trace line naming the
mode and stating that nothing was sent. It returns `{ ok: true }`.

**Why record rather than report `UnsupportedCapability`.** The failure being guarded against
is a developer believing their targeting works because nothing objected, with the first
evidence otherwise arriving in production. An explicit `[fireweave:local]` line preserves
that guarantee without the cost: nothing is silent, and local dev can exercise targeting
rules offline instead of only against fw-server.

The trace names the mode deliberately. A `[fireweave:local]` line appearing in a production
log is itself the signal that something booted in local mode by mistake.

The recorded set MUST be readable (`getRegisteredTargets`) so tests can assert registration
without capturing stdout, and the log sink MUST be injectable so a host that owns its logging
can route it.

`registerTarget` resolves rather than raising in both modes: it runs in sign-in paths, where
a targeting concern must not break authentication.

## Initialisation validation

Unlike reads, initialisation MUST fail loudly:

| Condition | Result |
| --- | --- |
| `mode` absent or unrecognised | `Configuration` |
| `mode: 'remote'`, `apiKey` or `apiUrl` missing/blank | `Configuration` |
| `apiUrl` fails the host allowlist | `Configuration` |
| `mode: 'local'` with credentials supplied | `Configuration` — the caller means one or the other |

The last row is deliberate. Accepting both silently is how a config file half-migrated from
remote to local passes review and then behaves as neither.

## Reading credentials

The core SDK reads **no environment variables**. Credentials arrive as explicit options. Env
reading belongs to the layer the caller opts into, which is what keeps the core bundler-safe and
deterministic under test.

The one sanctioned exception is the opt-in **start profile** (`start-profile.md`, ADR-0012): a
separate entry point that reads `FIREWEAVE_*` variables (or, in client apps, build-time values)
and chooses the mode by a fail-closed rule. It calls `initFireweave` with an explicit mode, so
every rule in this document still holds for the core underneath it.
