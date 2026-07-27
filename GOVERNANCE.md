# Governance

This document describes how the Fireweave SDK project is maintained and how decisions are made. It is intentionally lightweight for the pre-release phase and will be revisited before 1.0.

## Roles

### Maintainers

Maintainers are responsible for the health of the project: reviewing and merging pull requests, triaging issues, cutting releases (once publication is authorized), and upholding the [Code of Conduct](CODE_OF_CONDUCT.md).

Ownership is per-area — see [CODEOWNERS](CODEOWNERS). Each language SDK (`sdks/node`, `sdks/python`, `sdks/go`, `sdks/java`) has its own maintainer team; the canonical contract (`spec/`, `contracts/`) has a dedicated team whose review is required for any contract change.

New maintainers are nominated by an existing maintainer and confirmed by a simple majority of current maintainers. Maintainers who are inactive for six months may be moved to emeritus status by the same process.

### Contributors

Anyone who submits an issue, pull request, or review. Contributions are accepted under the [DCO](CONTRIBUTING.md#developer-certificate-of-origin-dco--not-a-cla).

## Decision process

1. **Default: lazy consensus.** Routine changes (bug fixes, docs, tests, non-breaking additions within one language) are decided in the pull request. Approval from one code-owning maintainer suffices; silence for a reasonable review window is consent.
2. **Cross-language API changes** require sign-off from the maintainers of **all four** language SDKs, because the project guarantees behavioral parity. The change lands with a parity plan (either simultaneous implementations or documented, fixture-tracked gaps).
3. **Canonical contract changes** (`spec/*.schema.json`, `contracts/**`) land only through orchestrated review: an issue describing the change, sign-off from the spec/contracts owners plus all affected language owners, and fixtures updated in the same change. See the [contract-change policy](CONTRIBUTING.md#contract-fixture-and-schema-change-policy).
4. **Escalation.** If consensus cannot be reached, maintainers vote; a simple majority of all active maintainers decides. Ties are broken by the project lead (currently the Fireweave engineering lead responsible for the SDK).

## Architecture Decision Records (ADRs)

Significant design decisions are recorded as ADRs in [`docs/adr/`](docs/adr/), numbered sequentially (`0001-…`, `0002-…`).

Conventions (matching the existing ADRs 0001–0004):

- **Header**: Status (Proposed / Accepted / Superseded), Date, Deciders, Tags.
- **Body**: Context and problem statement → decision drivers → considered options with pros/cons → decision outcome → consequences → references.
- An ADR is required for: new public API surfaces, changes to the adapter boundary or error taxonomy, new backend adapters, changes to the OpenFeature compliance floor, and scope changes (e.g. new runtime targets).
- Superseding an ADR requires a new ADR that names what it supersedes; the old ADR's status is updated but its text is never rewritten.

## Release authority

Publication to any registry (npm, PyPI, Maven Central, Go proxy) is **gated on explicit company authorization** (license ratification, package-name confirmation — ADR-0001 §9). Until then, releases are git tags only. Release mechanics live with the CI/release owners (`.github/`, `scripts/`).

## Changes to this document

Changes to GOVERNANCE.md follow process 4 (maintainer vote) with a two-thirds majority.
