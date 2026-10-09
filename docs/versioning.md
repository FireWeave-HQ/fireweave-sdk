# Versioning & stability policy

## Semantic versioning

All packages follow [SemVer 2.0.0](https://semver.org/spec/v2.0.0.html).

### Pre-1.0

Today only the spec is pre-1.0 (`spec/version.json`: 0.1.0); every package is 2.x. Per SemVer §4, 0.x makes no compatibility promises — concretely for this project:

- **0.x minor** (0.1 → 0.2): may include breaking public-API changes. Breaks are listed under a "Changed"/"Removed" heading in [CHANGELOG.md](../CHANGELOG.md) with migration notes.
- **0.x patch**: bug fixes and additive changes only.

### Post-1.0

- **Major**: any breaking change to public API, canonical spec semantics, or documented behavior; also dropping a supported language/runtime version.
- **Minor**: additive APIs, new adapters, new capability names, newly supported runtime versions.
- **Patch**: fixes, dependency bumps, docs.

## What counts as "public API"

Covered by the compatibility promise: exported/public types and functions of each SDK package, the canonical `fireweave.*` controlPointMetadata keys, the error-kind ↔ OpenFeature-code mapping, and documented configuration options. **Not covered**: anything under `internal/` (Go) or documented as a test/fixture hook (`seed`, `setFault`, conformance runners), and the `contracts/` fixture format (versioned separately via `schemaVersion`).

## Spec version

The canonical data model in `spec/` carries its own version, currently **0.1.0** (`spec/version.json`), with OpenFeature spec floor **v0.8.0**. Schema changes follow the same semver discipline (breaking schema change → spec major/minor per pre/post-1.0 rules) and land only through orchestrated review ([CONTRIBUTING.md](../CONTRIBUTING.md#contract-fixture-and-schema-change-policy)). SDK releases state which spec version they implement.

## Deprecation policy

1. Deprecations are announced in the CHANGELOG and marked in-code (`@deprecated` / Python `DeprecationWarning` / Go `// Deprecated:` / Java `@Deprecated`), with the replacement named.
2. Post-1.0, deprecated surfaces keep working for **at least one minor release** before removal in the next major.
3. Behavior deprecations (e.g. changing an adapter default like exposure emission) get a transition flag where feasible.

## Dependency-update policy

| Dependency | Policy |
| --- | --- |
| Language floors (Node 20.20 / Python 3.10 / Go 1.25 / Java 11) | Raising a floor is a breaking change (major post-1.0; called-out 0.x minor before) |

Security patches to dependencies may ship in a patch release, provided conformance stays green.
