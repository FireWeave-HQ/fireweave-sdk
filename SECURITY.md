# Security Policy

This file covers **how to report vulnerabilities**.

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

- The language SDKs (`sdks/`), including secret handling and redaction (`phc_`/`phs_`/`phx_` keys, bearer tokens), SSRF/host-allowlist enforcement, context-bounds enforcement, and the never-throw evaluation contract.
- The conformance/test infrastructure (`test-server/`, `contracts/`) insofar as it could compromise consumers.

Out of scope:

- Vulnerabilities requiring a malicious dependency or compromised build environment, unless this repository pins/validates incorrectly.

## Handling secrets in reports and fixtures

Never include real project or personal API keys anywhere in this repository. Test fixtures use obviously fake keys. Error-message redaction rules are specified in [`contracts/errors.md`](contracts/errors.md).
