# Modes — local and remote

- **Status:** Normative for SDK v1
- **Applies to:** every language SDK in `sdks/`
- **Related:** `control-points.md`, `remote-protocol.md`

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
| adapter | local, seeded map | remote, `POST /v1/flags/evaluate` |
| network | none | fw-server |
| required options | `local.controlPoints` (may be empty) | `apiKey`, `apiUrl` |
| unknown key | `default`, `reason: DEFAULT` | `default`, `reason: ERROR`, `FlagNotFound` |
| `registerTarget` | **not implemented** → `UnsupportedCapability` | `POST /v1/targets/register` |

Both modes expose the identical nine methods with identical signatures. A call site MUST NOT
need to know which mode it is running under.

## `registerTarget` in local mode

The local adapter MUST NOT implement the optional `registerTarget` port method. The runtime
reports `UnsupportedCapability` because the method is absent, not because of a mode check —
there is no mode-specific branch anywhere in the runtime.

It MUST NOT return success. A dev harness that reports a target as registered when nothing
was recorded teaches the developer that their targeting works, and the first evidence
otherwise arrives in production.

`registerTarget` resolves rather than raising: it runs in sign-in paths, where an analytics
concern must not break authentication.

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

The SDK reads **no environment variables**. Credentials arrive as explicit options. Env
reading belongs to the harness the caller owns, which is what keeps the SDK bundler-safe and
deterministic under test.
