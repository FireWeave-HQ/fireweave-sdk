# Support

## Where to get help

| Need | Channel |
| --- | --- |
| "How do I…?" usage questions | Read the [docs](docs/) first — [quickstart](docs/quickstart.md), [troubleshooting](docs/troubleshooting.md), [compatibility matrix](docs/compatibility.md). Then open a [GitHub Discussion / issue with the question template](.github/ISSUE_TEMPLATE/) |
| Bug reports | [Bug report issue](.github/ISSUE_TEMPLATE/bug_report.yml) — include language, SDK version/commit, adapter (in-memory vs PostHog, remote vs local eval), and a minimal reproduction |
| Feature requests | [Feature request issue](.github/ISSUE_TEMPLATE/feature_request.yml) |
| Documentation problems | [Docs issue](.github/ISSUE_TEMPLATE/docs.yml) |
| Security vulnerabilities | **Never a public issue** — see [SECURITY.md](SECURITY.md) |

## Support expectations (pre-release)

This SDK is **pre-release and unpublished**. There are no SLAs. Maintainers triage issues on a best-effort basis; issues that include a failing test or a runnable reproduction (ideally against the `InMemoryAdapter` or the `test-server/` stub, so no PostHog account is needed) get fixed fastest.

## Version support

Until 1.0, only the tip of the default branch is supported. Behavior may change between 0.x minor versions — see [docs/versioning.md](docs/versioning.md).

## Out of scope

- PostHog product/platform issues (flag definition UI, PostHog outages, billing/quota questions) → [PostHog support](https://posthog.com/docs/support-options). This SDK only documents how it *reacts* to PostHog behavior (e.g. [quota-limited responses](docs/posthog.md#quota-behavior)).
- OpenFeature SDK bugs → the respective [OpenFeature repositories](https://github.com/open-feature).
- Browser/mobile usage — phase one is server-only by design (ADR-0004).
