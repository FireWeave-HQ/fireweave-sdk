# Fireweave Java SDK example

Runnable walkthrough of the Java SDK. **Offline by default** — no credentials, no network.

This example is a Maven reactor that compiles `fireweave-sdk` from this repository. It does
**not** require `mvn install` or Maven Central.

## Offline (local development adapter)

```bash
cd examples/java
mvn -q compile exec:java
```

Demonstrates:

- `Fireweave.init` — the single entry point (spec/modes.md), local mode
- `client.controlPoints()` — boolean evaluation + detailed resolution
- a targeting context
- `registerTarget` — durable targeting facts, once per login
- clean shutdown

## Remote

```bash
cd examples/java
mvn -q compile exec:java -Dexec.args="--remote"
```

Defaults to the local `test-server` stub (`http://127.0.0.1:3901`, a dev project key); set
`FW_API_URL` / `FW_PROJECT_API_KEY` to point at a real fw-server instead. The demo never
prints the project API key.

```bash
FW_PROJECT_API_KEY=project-api-key_… \
FW_API_URL=https://app-server.fireweave.ai \
mvn -q compile exec:java -Dexec.args="--remote"
```

Demonstrates `Fireweave.init` (remote mode), `client.controlPoints()`, `registerTarget`
(degrades to `{ok: false}` rather than throwing — the test-server stub has no
`/v1/targets/register` route), and clean shutdown.
