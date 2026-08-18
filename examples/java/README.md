# Fireweave Java SDK example

Runnable walkthrough of the Java SDK. **Offline by default** — no credentials, no network.

This example is a Maven reactor that compiles `fireweave-sdk` and `fireweave-openfeature`
from this repository. It does **not** require `mvn install` or Maven Central.

## Offline (local development provider)

```bash
cd examples/java
mvn -q compile exec:java
```

Demonstrates:

- `FireweaveLocalAdapter` + `FireweaveLocalProvider` (no credentials)
- boolean / string / object evaluation
- `client.controlPoints()`
- targeting context
- OpenFeature
- target registration result on an adapter that does not speak `/v1/targets/register`
- clean shutdown

## Remote

Requires environment variables. The demo never prints the project API key.

```bash
cd examples/java
FW_PROJECT_API_KEY=project-api-key_… \
FW_API_URL=https://app-server.fireweave.ai \
mvn -q compile exec:java -Dexec.args="--remote"
```

Loopback `http://127.0.0.1:…` is accepted for the repository test server.

Demonstrates configuration, runtime init, `FireweaveRemoteAdapter`, OpenFeature, control-point evaluation, `registerTarget`, an exposure flush, a signal, and shutdown.
