package ai.fireweave.examples;

import ai.fireweave.sdk.application.Fireweave;
import ai.fireweave.sdk.application.FireweaveClient;
import ai.fireweave.sdk.application.InitOptions;
import ai.fireweave.sdk.application.RegisterTargetOptions;
import ai.fireweave.sdk.application.RegisterTargetResult;
import ai.fireweave.sdk.domain.Decision;
import ai.fireweave.sdk.domain.EvaluationContext;
import ai.fireweave.sdk.domain.JsonValue;
import ai.fireweave.sdk.domain.TargetKind;

import java.util.Collections;

/**
 * Runnable Fireweave Java SDK walkthrough — the v1 surface (spec/control-points.md):
 * {@code Fireweave.init}, control-point evaluation, and target registration.
 *
 * <p>Offline (default): no credentials, no network.
 * {@code mvn -q compile exec:java}
 *
 * <p>Remote: {@code FW_API_URL} / {@code FW_PROJECT_API_KEY} (or the local test-server stub
 * defaults below).
 * {@code mvn -q compile exec:java -Dexec.args="--remote"}
 *
 * <p>Never prints the project API key.
 */
public final class DemoApp {

    public static void main(String[] args) {
        boolean remote = false;
        for (String arg : args) {
            if ("--remote".equals(arg)) {
                remote = true;
            }
        }

        // 1. Fireweave.init is the single entry point (spec/modes.md) — it
        // validates the mode, builds the matching adapter, and brings the
        // client to READY.
        FireweaveClient client = remote ? initRemote() : initLocal();

        // Stub fixture key when talking to the Fireweave remote protocol.
        String boolFlag = remote ? "fw-bool-on" : "new-checkout";

        // 2. Evaluate a boolean control point with a targeting context.
        EvaluationContext ctx = EvaluationContext.builder()
                .targetingKey("user_42")
                .attribute("plan", "pro")
                .build();
        boolean enabled = client.controlPoints().getBooleanValue(boolFlag, false, ctx);
        System.out.println(boolFlag + " enabled: " + enabled);

        // 3. Detailed resolution: value + variant + reason (upgrades from
        // getBooleanValue without restructuring the call).
        Decision details = client.controlPoints().getBooleanDetails(boolFlag, false, ctx);
        System.out.println(boolFlag + " details: value=" + details.value().asBoolean()
                + " variant=" + details.variant() + " reason=" + details.reason());

        // 4. Register the durable targeting facts for this user — once per
        // login, not on every evaluation. Resolves ok=false rather than
        // throwing (it runs in sign-in paths); the offline default and the
        // --remote stub (which has no /v1/targets/register route) both
        // degrade the same, honest way.
        RegisterTargetResult registered = client.registerTarget("user_42",
                RegisterTargetOptions.builder()
                        .kind(TargetKind.USER)
                        .property("plan", JsonValue.of("pro"))
                        .build());
        System.out.println("registerTarget ok: " + registered.ok()
                + (registered.ok() ? "" : " (" + registered.error().kind() + ")"));

        // 5. Clean shutdown.
        client.close();
        System.out.println("shut down cleanly");
    }

    private static FireweaveClient initLocal() {
        // Local mode seeds a deterministic in-process map — no network, no
        // credentials. Great for tests and offline dev.
        return Fireweave.init(InitOptions.local(Collections.singletonMap("new-checkout", true)));
    }

    private static FireweaveClient initRemote() {
        String apiUrl = envOrDefault("FW_API_URL", "http://127.0.0.1:3901");
        String apiKey = envOrDefault("FW_PROJECT_API_KEY", "project-api-key_dev");
        return Fireweave.init(InitOptions.remote(apiKey, apiUrl));
    }

    private static String envOrDefault(String name, String fallback) {
        String value = System.getenv(name);
        return value == null || value.isEmpty() ? fallback : value;
    }

    private DemoApp() {
    }
}
