# Start-profile conformance suite (`contracts/start/`)

Cross-language fixtures for [`spec/start-profile.md`](../../spec/start-profile.md) (ADR-0012).
This suite sits **outside** the frozen 65-fixture matrix, like `contracts/web/`: it has its own
schema, its own per-language report and its own aggregator
(`tools/conformance/compare-start.mjs`).

Every fixture is a rule group with `cases`; each case cites nothing on its own, the fixture's
`rules` list the spec ids it pins. Fixtures are `provisional: true` until ADR-0012 is accepted.

## Shape

See [`start-fixture.schema.json`](./start-fixture.schema.json) (closed: unknown fields are
rejected). In short:

```json
{
  "schemaVersion": 1, "id": "start-mode-rule", "suite": "start",
  "description": "…", "rules": ["SP-6", "SP-7"], "profile": "server", "provisional": true,
  "cases": [
    { "name": "no-key-production-fails-closed",
      "when": { "operation": "resolve", "env": { "FIREWEAVE_ENV": "production" } },
      "expect": { "error": { "kind": "Configuration", "mentions": ["FIREWEAVE_KEY"] } } }
  ],
  "compatibility": { "node": "pass", "web": "not-applicable", "…": "…" },
  "limitations": { "web": "server-profile fixture; web has only the client profile" }
}
```

- `profile` is `server`, `client` or `any`. Dart and Swift have both profiles: a `server`
  fixture runs against `server.dart` / the Swift server profile, a `client` fixture against
  `client.dart` / the Swift app profile.
- `compatibility.<lang>` is `pass`, `fail`, `skipped-with-documented-limitation` or
  `not-applicable`; every value other than `pass` needs a `limitations.<lang>` reason.
- `cases[].appliesTo` narrows a single case to some languages (for example, an invalid `mode`
  string cannot be expressed where `mode` is an enum). A language outside `appliesTo` reports
  the case as `not-applicable`.

## Operations

| `when.operation` | Inputs | What the runner calls |
| --- | --- | --- |
| `resolve` | `options`, `env` (server), `build` (client), `channel` (default `production`) | The start profile's resolver with that configuration, **no I/O**. Server: `env` replaces the process environment. Client: `build` holds the build-time values (web: what the `fireweave()` plugin injects; Dart: compile-time defines; Swift: Info.plist values). A client runner treats the build as a **release** build (no debug fallback, SP-11). |
| `instanceKey` | `options.instanceId`, `env`, `hostName` (`null` = the host name is unavailable) | The instance-key derivation with that host name injected. |
| `defineFlags` | `flags` (canonical `{ key: { local, description? } }`) | The language's `defineFlags` / `define_flags`, translated to its own types. |
| `channelForVersion` | `version` | The pure version → channel rule. |

Option names are canonical (`key`, `url`, `environment`, `mode`, `instanceId`); a runner maps
them to the language's spelling.

## Comparing results

Only the fields present in `expect` are checked.

| Field | Rule |
| --- | --- |
| `mode`, `modeSource`, `url`, `environment`, `value`, `channel` | Exact (`url` after the SDK's own trailing-slash trim). |
| `keySource`, `urlSource`, `environmentSource` | **Normalised** first: a variable or build-value name stays as it is (`FIREWEAVE_KEY`, `FW_API_URL`, `FIREWEAVE_BROWSER_KEY`); any option source becomes `option`; the default endpoint becomes `channel`; no key becomes `none`. |
| `allowedHosts` | `null` means the SDK passes no allowlist (the core default applies). A list is compared as a **set**. |
| `error` | The resolver signals a configuration fault — by throwing the core's Configuration error (servers) or by returning a failure (client profiles that never throw). `mentions`: each name appears in the error message. `mustNotMention`: none appears (this is how "never echo a key" is pinned). |
| `warnings` | Over all warning lines the resolution produced: each `mention` name appears in at least one line; no `mustNotMention` name appears in any line. |
| `ok` | `defineFlags` returned without an error. |
| `error` on `defineFlags` | The language's rejection of a bad flags object counts as the Configuration error: a core Configuration error where the core error can carry a message naming the bad key (Node, Python, Go, Java, Rust, Dart, Swift), and a `TypeError` whose message starts with `[fireweave]` on web, whose core errors carry fixed messages only. Any other thrown error fails the case. |
| `prefix` | The value starts with it (the random instance key). |

Message text is never compared: languages word messages differently, and only the names in
them are contractual.

## Reports

Each runner writes `compatibility-report.start.<lang>.json` next to its existing report:

```json
{ "language": "node", "suite": "start",
  "results": [ { "fixtureId": "start-mode-rule", "status": "pass",
                 "cases": [ { "name": "…", "status": "pass" }, { "name": "…", "status": "not-applicable" } ],
                 "message": "" } ] }
```

A fixture passes for a language when every applicable case passes. A runner exits non-zero when
a fixture declared `pass` for its language does not pass. `node tools/conformance/compare-start.mjs`
validates every fixture against the schema and, given reports, prints the cross-language matrix.
