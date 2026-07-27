# Fireweave Go SDK example

Offline by default — runs against the deterministic in-memory adapter:

```sh
go run .
```

To exercise the PostHog-backed provider instead, supply credentials:

```sh
FW_PROJECT_API_KEY=phc_... FW_POSTHOG_HOST=https://us.i.posthog.com go run .
# optional: FW_SECRET_KEY=phs_... enables local flag evaluation
```

The example demonstrates OpenFeature registration (`SetProviderAndWait`),
boolean evaluation, detailed resolution (variant / reason / `fireweave.*`
metadata), targeting context (`targetingKey` → `distinct_id`),
`Releases.SetContext`, `Signals.RecordHealth`, capability discovery, and a
deadline-bounded clean shutdown.
