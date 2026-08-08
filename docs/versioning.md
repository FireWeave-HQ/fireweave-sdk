# Versioning & stability policy

## Semantic versioning

All packages follow [SemVer 2.0.0](https://semver.org/spec/v2.0.0.html) and are released in lockstep across the four languages (one version number for the SDK line; a release may be a no-op for a language, but versions never diverge).

Current version: **0.1.0, unpublished** — nothing is on any registry; install from a repository checkout ([quickstart.md](quickstart.md)).

### Pre-1.0 (now)

Per SemVer §4, 0.x makes no compatibility promises — concretely for this project:

- **0.x minor** (0.1 → 0.2): may include breaking public-API changes. Breaks are listed under a "Changed"/"Removed" heading in [CHANGELOG.md](../CHANGELOG.md) with migration notes.
- **0.x patch**: bug fixes and additive changes only.
- The **OpenFeature flag-getter surface is stabler than the rest**: it follows OpenFeature's own contract, so evaluation call sites are unlikely to break even across 0.x minors. The Fireweave-native surfaces (extensions, adapter interfaces, capability shapes) are where pre-1.0 movement happens — the known cross-language shape divergences in [compatibility.md](compatibility.md#known-gaps) will be reconciled in a 0.x minor before 1.0.

### Post-1.0

- **Major**: any breaking change to public API, canonical spec semantics, or documented behavior; also dropping a supported language/runtime version.
- **Minor**: additive APIs, new adapters, new capability names, newly supported runtime versions.
- **Patch**: fixes, dependency bumps within pinned ranges, docs.

## What counts as "public API"

Covered by the compatibility promise: exported/public types and functions of each SDK package, the canonical `fireweave.*` flagMetadata keys, canonical capability names, the error-kind ↔ OpenFeature-code mapping, and documented configuration options. **Not covered**: anything under `internal/` (Go) or documented as a test/fixture hook (`seed`, `setFault`, conformance runners), the `contracts/` fixture format (versioned separately via `schemaVersion`), and `[Experimental]`-labeled surfaces ([concepts.md](concepts.md#feature-labeling-convention-used-across-these-docs)).

## Spec version

The canonical data model in `spec/` carries its own version, currently **0.1.0** (`spec/version.json`), with OpenFeature spec floor **v0.8.0**. Schema changes follow the same semver discipline (breaking schema change → spec major/minor per pre/post-1.0 rules) and land only through orchestrated review ([CONTRIBUTING.md](../CONTRIBUTING.md#contract-fixture-and-schema-change-policy)). SDK releases state which spec version they implement; `capabilities.get` reports it at runtime.

## Deprecation policy

1. Deprecations are announced in the CHANGELOG and marked in-code (`@deprecated` / Python `DeprecationWarning` / Go `// Deprecated:` / Java `@Deprecated`), with the replacement named.
2. Post-1.0, deprecated surfaces keep working for **at least one minor release** before removal in the next major. Pre-1.0, deprecated surfaces keep working for at least one 0.x minor.
3. Behavior deprecations (e.g. changing an adapter default like exposure emission) get a transition flag where feasible.
4. Deprecated **vendor per-flag APIs are never used** (ADR-0002); vendor deprecations are absorbed inside the adapter without public-API change whenever possible. On Node there is no vendor adapter to absorb them ([ADR-0006](adr/0006-node-drops-direct-posthog-adapter.md)).

## Dependency-update policy

Vendor SDKs are **pinned exactly** and updated deliberately, never automatically:

| Dependency | Policy |
| --- | --- |
| Vendor SDKs (`posthog` 7.31.0, `posthog-go` v1.22.0) | Exact pins; bumps require the conformance suite plus adapter integration tests against the test-server, and a CHANGELOG entry. Python and Go only — the Node package has no vendor dependency |
| `com.posthog:posthog-server` (Java) | Adopted when published (orchestrator-gated decision); until then the seam stands ([posthog.md](posthog.md#java)) |
| OpenFeature SDKs | Node: caret peer range (`^1.22.0`); Python: `>=0.10,<0.11` (pre-1.0 upstream — widened only after compatibility validation); Go/Java: pinned, bumped with conformance re-runs |
| Language floors (Node 20.20 / Python 3.10 / Go 1.25 / Java 11) | Raising a floor is a breaking change (major post-1.0; called-out 0.x minor before) |

Security patches to dependencies may ship in a patch release even when they technically bump a pin, provided conformance stays green.

## Release gating (pre-release reality)

Publication to npm/PyPI/Maven Central/Go proxy is blocked on company decisions: license ratification (MIT assumed), final package names, and publication authorization (ADR-0001 §9). Until those clear, "releases" are git tags, and this policy governs the tagged source.
