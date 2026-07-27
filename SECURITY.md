# Security Policy

This file covers **how to report vulnerabilities**. The project's threat model, redaction rules, and security design documentation live in [`docs/security/`](docs/security/).

## Reporting a vulnerability

**Do not open a public GitHub issue for security problems.**

Report privately via one of:

- Email: **security@fireweave.ai**
- GitHub private vulnerability reporting ("Report a vulnerability" on the repository's Security tab), if enabled.

Include: affected language SDK(s) and commit/version, a description of the issue and its impact, reproduction steps or a proof of concept, and any suggested fix. Please redact real API keys from reports.

## What to expect

- **Acknowledgement** within 3 business days.
- We will investigate, keep you informed of progress, and credit you in the fix's release notes unless you prefer otherwise.
- Please allow us a reasonable window to remediate before public disclosure; we aim for 90 days or better.

## Scope

In scope:

- The four language SDKs (`sdks/`), including secret handling and redaction (`phc_`/`phs_`/`phx_` keys, bearer tokens), SSRF/host-allowlist enforcement, context-bounds enforcement, and the never-throw evaluation contract.
- The conformance/test infrastructure (`test-server/`, `contracts/`) insofar as it could compromise consumers.

Out of scope:

- PostHog's own services and SDKs (report to [PostHog](https://posthog.com/security)).
- Vulnerabilities requiring a malicious dependency or compromised build environment, unless this repository pins/validates incorrectly.
- Use of secret keys (`phs_`/`phx_`) in browsers or other untrusted runtimes — this is explicitly unsupported (ADR-0004; local evaluation is server-only).

## Handling secrets in reports and fixtures

Never include real project or personal API keys anywhere in this repository. Test fixtures use obviously fake keys (`phc_example`, `phc_EXAMPLE…`). Error-message redaction rules are specified in [`contracts/errors.md`](contracts/errors.md).
