# Fireweave Go SDK example

Offline by default (`Mode: fireweave.ModeLocal` — no network, no credentials):

```sh
go run .
```

To exercise the remote path instead, supply credentials (or point `FW_API_URL`
at the local `test-server` stub):

```sh
go run . --remote
FW_API_URL=... FW_PROJECT_API_KEY=... go run . --remote
```

The example demonstrates `fireweave.Init` (the single entry point), boolean
control-point evaluation, detailed resolution (variant / reason),
a targeting context, `RegisterTarget`, and a deadline-bounded clean shutdown.
