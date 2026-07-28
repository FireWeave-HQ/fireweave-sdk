package ai.fireweave.examples;

import ai.fireweave.adapter.posthog.PostHogAdapter;
import ai.fireweave.adapter.posthog.PostHogClientApi;
import ai.fireweave.adapter.posthog.PostHogFlagsSnapshot;
import ai.fireweave.openfeature.FireweaveProvider;
import ai.fireweave.sdk.FireweaveClient;
import ai.fireweave.sdk.FireweaveConfig;
import ai.fireweave.sdk.FireweaveRuntime;
import ai.fireweave.sdk.JsonValue;
import ai.fireweave.sdk.ReleaseContext;
import ai.fireweave.testing.FlagDefinition;
import ai.fireweave.testing.InMemoryAdapter;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.openfeature.sdk.Client;
import dev.openfeature.sdk.FlagEvaluationDetails;
import dev.openfeature.sdk.MutableContext;
import dev.openfeature.sdk.OpenFeatureAPI;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Fireweave Java SDK walkthrough. OFFLINE BY DEFAULT: no network calls are made anywhere.
 *
 * <p>Part 1 registers a PostHog-backed provider (injected offline stub client — the pinned
 * com.posthog:posthog-server:2.9.0 artifact is not yet published; the wiring is identical once
 * it is). Part 2 shows the in-memory adapter for tests.
 */
public final class ExampleApp {

    public static void main(String[] args) throws Exception {
        posthogBackedProvider();
        inMemoryTesting();
        System.out.println("done.");
    }

    // ------------------------------------------------------------ Part 1: PostHog-backed

    static void posthogBackedProvider() throws Exception {
        // 1. Plain-constructor wiring (DI-friendly, no framework, no statics):
        //    config + adapter + runtime + provider.
        FireweaveConfig config = FireweaveConfig.builder()
                .projectApiKey("phc_EXAMPLE00000000000000000000001") // stub key, never sent anywhere
                .host("http://127.0.0.1:3901")                       // SSRF-allowlisted example host
                .build();
        PostHogAdapter adapter = new PostHogAdapter(new OfflinePostHogClient()); // injected client
        FireweaveRuntime runtime = new FireweaveRuntime(config, adapter);
        FireweaveProvider provider = new FireweaveProvider(runtime);

        // 2. Register with OpenFeature (domain-scoped; no global singleton client in the SDK).
        OpenFeatureAPI api = OpenFeatureAPI.getInstance();
        api.setProviderAndWait("example", provider);
        Client client = api.getClient("example");

        // 3. Targeting context: targetingKey maps to PostHog distinct_id.
        MutableContext ctx = new MutableContext("org_01HZXEXAMPLE0000000000001");
        ctx.add("plan", "enterprise");

        // 4. Simple boolean evaluation (defaults never throw).
        boolean checkoutV2 = client.getBooleanValue("checkout-v2", false, ctx);
        System.out.println("checkout-v2 enabled: " + checkoutV2);

        // 5. Detailed resolution: variant, reason, flag metadata.
        FlagEvaluationDetails<String> details =
                client.getStringDetails("checkout-theme", "light", ctx);
        System.out.println("checkout-theme: value=" + details.getValue()
                + " variant=" + details.getVariant()
                + " reason=" + details.getReason());

        // 6. Release-safety extensions on the FireweaveClient facade.
        FireweaveClient fireweave = new FireweaveClient(runtime);
        // IDs are typed Crockford ULIDs per spec/release-context.schema.json; setContext
        // validates the schema's required fields (rolloutId + stampIds) and rejects bad shapes.
        var bound = fireweave.releases().setContext(ReleaseContext.builder()
                .stampId("stmp_01HZXEXAMP0E00000000000001")
                .rolloutId("rollout_example_1")
                .changeId("chg_01HZXEXAMP0E00000000000001")
                .build());
        if (!bound.isOk()) {
            throw new IllegalStateException("release context rejected: " + bound.error().message());
        }
        fireweave.signals().recordHealth("provider", "ok");
        System.out.println("release context bound + health signal recorded");

        // 7. Clean shutdown (idempotent; closes the runtime, not the injected client).
        api.shutdown();
        System.out.println("provider state after shutdown: " + runtime.state());
    }

    // ------------------------------------------------------------ Part 2: in-memory testing

    static void inMemoryTesting() throws Exception {
        // Deterministic fixture-style flags — ideal for unit tests, zero I/O.
        ObjectMapper m = new ObjectMapper();
        Map<String, FlagDefinition> flags = new LinkedHashMap<>();
        flags.put("new-onboarding", FlagDefinition.fromJson(m.readTree(
                "{\"type\":\"boolean\",\"enabled\":true,\"variant\":\"on\",\"value\":true}")));

        FireweaveRuntime runtime = new FireweaveRuntime(
                FireweaveConfig.builder().build(), new InMemoryAdapter(flags));
        FireweaveProvider provider = new FireweaveProvider(runtime);

        OpenFeatureAPI api = OpenFeatureAPI.getInstance();
        api.setProviderAndWait("example-tests", provider);
        boolean enabled = api.getClient("example-tests")
                .getBooleanValue("new-onboarding", false,
                        new MutableContext("user_test_1"));
        System.out.println("in-memory new-onboarding: " + enabled);
        provider.shutdown();
    }

    /**
     * Offline stand-in for the real posthog-server client: serves a canned snapshot, captures
     * nothing. Replace with the real binding once com.posthog:posthog-server is published.
     */
    static final class OfflinePostHogClient implements PostHogClientApi {

        @Override
        public PostHogFlagsSnapshot evaluateFlags(String distinctId,
                                                  Map<String, JsonValue> personProperties,
                                                  Map<String, String> groups,
                                                  Map<String, Map<String, JsonValue>> groupProperties) {
            Map<String, PostHogFlagsSnapshot.FlagResult> flags = new LinkedHashMap<>();
            flags.put("checkout-v2", new PostHogFlagsSnapshot.FlagResult(
                    "checkout-v2", true, "on", null, null, "condition_match", 0, 101, 3));
            flags.put("checkout-theme", new PostHogFlagsSnapshot.FlagResult(
                    "checkout-theme", true, "dark", JsonValue.of("dark"), null,
                    "condition_match", 0, 102, 5));
            return new PostHogFlagsSnapshot(flags, Collections.emptyList(), false, 0);
        }

        @Override
        public void capture(String distinctId, String event, Map<String, JsonValue> properties) {
            // Offline: drop events.
        }

        @Override
        public void close() {
        }
    }

    private ExampleApp() {
    }
}
