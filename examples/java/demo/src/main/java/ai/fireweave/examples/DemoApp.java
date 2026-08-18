package ai.fireweave.examples;

import ai.fireweave.openfeature.FireweaveLocalProvider;
import ai.fireweave.openfeature.FireweaveProvider;
import ai.fireweave.sdk.Decision;
import ai.fireweave.sdk.EvaluationContext;
import ai.fireweave.sdk.Exposure;
import ai.fireweave.sdk.FireweaveClient;
import ai.fireweave.sdk.FireweaveConfig;
import ai.fireweave.sdk.FireweaveLocalAdapter;
import ai.fireweave.sdk.FireweaveRemoteAdapter;
import ai.fireweave.sdk.FireweaveRuntime;
import ai.fireweave.sdk.FlagType;
import ai.fireweave.sdk.JsonValue;
import ai.fireweave.sdk.RegisterTargetOptions;
import ai.fireweave.sdk.RegisterTargetResult;
import ai.fireweave.sdk.TargetKind;
import dev.openfeature.sdk.Client;
import dev.openfeature.sdk.MutableContext;
import dev.openfeature.sdk.OpenFeatureAPI;
import dev.openfeature.sdk.Value;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Runnable Fireweave Java SDK walkthrough.
 *
 * <p>Offline (default): no credentials, no network.
 * {@code mvn -q compile exec:java}
 *
 * <p>Remote: {@code FW_PROJECT_API_KEY} and {@code FW_API_URL} required.
 * {@code mvn -q compile exec:java -Dexec.args="--remote"}
 *
 * <p>Never prints the project API key.
 */
public final class DemoApp {

    public static void main(String[] args) throws Exception {
        boolean remote = false;
        for (String arg : args) {
            if ("--remote".equals(arg)) {
                remote = true;
            }
        }
        System.out.println("FireWeave Java SDK demo");
        System.out.println("========================");
        System.out.println();
        if (remote) {
            runRemote();
        } else {
            runOffline();
        }
    }

    private static void runOffline() throws Exception {
        System.out.println("Mode: OFFLINE");
        System.out.println();

        Map<String, Boolean> devFlags = new LinkedHashMap<>();
        devFlags.put("new-checkout", true);

        FireweaveLocalAdapter adapter = new FireweaveLocalAdapter(devFlags);
        FireweaveRuntime runtime = new FireweaveRuntime(FireweaveConfig.builder().build(), adapter);
        runtime.initialize();
        FireweaveClient client = new FireweaveClient(runtime);
        EvaluationContext targeting = EvaluationContext.builder().targetingKey("user_42").build();

        System.out.println("Runtime: " + runtime.state());
        System.out.println();

        Decision checkout = client.controlPoints().evaluate(
                "new-checkout", FlagType.BOOLEAN, JsonValue.of(false), targeting, null);
        printControlPoint("new-checkout", String.valueOf(checkout.value().asBoolean()),
                checkout.variant(), checkout.reason());

        FireweaveLocalProvider localProvider = FireweaveLocalProvider.create(devFlags);
        OpenFeatureAPI api = OpenFeatureAPI.getInstance();
        api.setProviderAndWait("demo-offline", localProvider);
        Client of = api.getClient("demo-offline");
        MutableContext ofCtx = new MutableContext("user_42");

        var labelDetails = of.getStringDetails("checkout-label", "new-checkout", ofCtx);
        printControlPoint("checkout-label", quote(labelDetails.getValue()),
                labelDetails.getVariant(), labelDetails.getReason());

        var themeDetails = of.getObjectDetails("checkout-theme", new Value("midnight"), ofCtx);
        printControlPoint("checkout-theme", quote(themeDetails.getValue().asString()),
                themeDetails.getVariant(), themeDetails.getReason());

        System.out.println("Target:");
        System.out.println("  targetingKey: user_42");
        RegisterTargetResult registered = client.registerTarget("user_42",
                RegisterTargetOptions.builder()
                        .kind(TargetKind.USER)
                        .property("plan", JsonValue.of("pro"))
                        .build());
        System.out.println("  registerTarget: " + (registered.ok()
                ? "ok"
                : registered.error().kind() + " (expected offline — local adapter has no register)"));
        System.out.println();

        boolean ofCheckout = of.getBooleanValue("new-checkout", false, ofCtx);
        System.out.println("OpenFeature:");
        System.out.println("  new-checkout = " + ofCheckout);
        System.out.println();

        api.shutdown();
        client.close();
        System.out.println("Runtime shutdown: OK");
    }

    private static void runRemote() throws Exception {
        String apiUrl = System.getenv("FW_API_URL");
        String apiKey = System.getenv("FW_PROJECT_API_KEY");
        if (isBlank(apiUrl) || isBlank(apiKey)) {
            System.err.println("Remote mode requires FW_API_URL and FW_PROJECT_API_KEY.");
            System.err.println("The project API key is never printed.");
            System.exit(2);
            return;
        }

        System.out.println("Mode: REMOTE");
        System.out.println("API URL: " + apiUrl);
        System.out.println();

        FireweaveConfig config = FireweaveConfig.builder()
                .host(apiUrl)
                .projectApiKey(apiKey)
                .build();
        FireweaveRemoteAdapter adapter = new FireweaveRemoteAdapter();
        FireweaveRuntime runtime = new FireweaveRuntime(config, adapter);
        runtime.initialize();
        FireweaveClient client = new FireweaveClient(runtime);
        EvaluationContext targeting = EvaluationContext.builder().targetingKey("user_42").build();

        System.out.println("Runtime: " + runtime.state());
        System.out.println();

        RegisterTargetResult registered = client.registerTarget("user_42",
                RegisterTargetOptions.builder()
                        .kind(TargetKind.USER)
                        .environment("demo")
                        .property("plan", JsonValue.of("pro"))
                        .build());
        System.out.println("Target:");
        System.out.println("  targetingKey: user_42");
        System.out.println("  registerTarget: " + (registered.ok()
                ? "ok"
                : registered.error().kind() + " — " + registered.error().message()));
        System.out.println();

        Decision checkout = client.controlPoints().evaluate(
                "new-checkout", FlagType.BOOLEAN, JsonValue.of(false), targeting, null);
        printControlPoint("new-checkout", String.valueOf(
                        checkout.value().kind() == JsonValue.Kind.BOOLEAN
                                ? checkout.value().asBoolean() : false),
                checkout.variant(), checkout.reason());

        Decision label = client.controlPoints().evaluate(
                "checkout-label", FlagType.STRING, JsonValue.of("new-checkout"), targeting, null);
        String labelValue = label.value().kind() == JsonValue.Kind.STRING
                ? label.value().asString() : "new-checkout";
        printControlPoint("checkout-label", quote(labelValue), label.variant(), label.reason());

        client.exposures().record(new Exposure(
                "user_42", "new-checkout", checkout.variant(), checkout.value(), null));
        client.exposures().flush();
        client.signals().recordOutcome("demo", "completed");
        System.out.println("Exposure recorded + flushed; outcome signal sent.");
        System.out.println();

        OpenFeatureAPI api = OpenFeatureAPI.getInstance();
        api.setProviderAndWait("demo-remote", new FireweaveProvider(runtime, FireweaveProvider.InitMode.MANUAL));
        Client of = api.getClient("demo-remote");
        MutableContext ofCtx = new MutableContext("user_42");
        System.out.println("OpenFeature:");
        System.out.println("  new-checkout = " + of.getBooleanValue("new-checkout", false, ofCtx));
        System.out.println();

        api.shutdown();
        client.close();
        System.out.println("Runtime shutdown: OK");
    }

    private static void printControlPoint(String key, String value, String variant, String reason) {
        System.out.println("Control point: " + key);
        System.out.println("  value: " + value);
        if (variant != null && !variant.isEmpty()) {
            System.out.println("  variant: " + variant);
        }
        System.out.println("  reason: " + reason);
        System.out.println();
    }

    private static String quote(String s) {
        return "\"" + s + "\"";
    }

    private static boolean isBlank(String s) {
        return s == null || s.trim().isEmpty();
    }

    private DemoApp() {
    }
}
