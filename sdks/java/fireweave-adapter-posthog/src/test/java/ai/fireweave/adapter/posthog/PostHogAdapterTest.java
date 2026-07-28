package ai.fireweave.adapter.posthog;

import ai.fireweave.sdk.Decision;
import ai.fireweave.sdk.ErrorKind;
import ai.fireweave.sdk.EvaluationContext;
import ai.fireweave.sdk.EvaluationOptions;
import ai.fireweave.sdk.EvaluationRequest;
import ai.fireweave.sdk.Exposure;
import ai.fireweave.sdk.FireweaveConfig;
import ai.fireweave.sdk.FireweaveException;
import ai.fireweave.sdk.FlagType;
import ai.fireweave.sdk.JsonValue;
import ai.fireweave.sdk.Reasons;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Adapter mapping tests against a fake PostHog client (no network, no vendor SDK). */
class PostHogAdapterTest {

    /** Deterministic fake client. */
    static final class FakeClient implements PostHogClientApi {
        PostHogFlagsSnapshot snapshot = new PostHogFlagsSnapshot(
                Collections.emptyMap(), Collections.emptyList(), false, 0);
        PostHogTransportException failure;
        final List<String> capturedEvents = new ArrayList<>();
        final List<Map<String, JsonValue>> capturedProps = new ArrayList<>();
        boolean closed;

        @Override
        public PostHogFlagsSnapshot evaluateFlags(String distinctId,
                                                  Map<String, JsonValue> personProperties,
                                                  Map<String, String> groups,
                                                  Map<String, Map<String, JsonValue>> groupProperties)
                throws PostHogTransportException {
            if (failure != null) {
                throw failure;
            }
            return snapshot;
        }

        @Override
        public void capture(String distinctId, String event, Map<String, JsonValue> properties) {
            capturedEvents.add(event);
            capturedProps.add(properties);
        }

        @Override
        public void close() {
            closed = true;
        }
    }

    private static PostHogFlagsSnapshot snapshotOf(PostHogFlagsSnapshot.FlagResult... flags) {
        Map<String, PostHogFlagsSnapshot.FlagResult> m = new LinkedHashMap<>();
        for (PostHogFlagsSnapshot.FlagResult f : flags) {
            m.put(f.key(), f);
        }
        return new PostHogFlagsSnapshot(m, Collections.emptyList(), false, 0);
    }

    private static EvaluationRequest request(String key, FlagType type, JsonValue def) {
        return new EvaluationRequest(key, type, def,
                EvaluationContext.builder().targetingKey("user_1").build(),
                EvaluationOptions.defaults());
    }

    private static PostHogAdapter adapter(FakeClient client) throws FireweaveException {
        PostHogAdapter a = new PostHogAdapter(client);
        a.initialize(FireweaveConfig.builder().projectApiKey("phc_TESTKEY000000000000000001").build());
        return a;
    }

    @Test
    void booleanFlagFromEnabled() throws Exception {
        FakeClient client = new FakeClient();
        client.snapshot = snapshotOf(new PostHogFlagsSnapshot.FlagResult(
                "fw-bool", true, "on", null, null, "condition_match", 0, 1, 3));
        Decision d = adapter(client).evaluate(request("fw-bool", FlagType.BOOLEAN, JsonValue.of(false)));
        assertEquals(JsonValue.of(true), d.value());
        assertEquals("on", d.variant());
        assertEquals(Reasons.TARGETING_MATCH, d.reason());
        assertEquals(3, ((Number) d.flagMetadata().get("fireweave.flagVersion")).intValue());
        assertEquals("condition_match", d.flagMetadata().get("fireweave.reasonCode"));
    }

    @Test
    void multivariateStringFromVariant() throws Exception {
        FakeClient client = new FakeClient();
        client.snapshot = snapshotOf(new PostHogFlagsSnapshot.FlagResult(
                "fw-mv", true, "treatment-b", null, null, null, null, null, null));
        Decision d = adapter(client).evaluate(request("fw-mv", FlagType.STRING, JsonValue.of("control")));
        assertEquals(JsonValue.of("treatment-b"), d.value());
    }

    @Test
    void disabledFlagReason() throws Exception {
        FakeClient client = new FakeClient();
        client.snapshot = snapshotOf(new PostHogFlagsSnapshot.FlagResult(
                "fw-off", false, "off", JsonValue.of(false), null, null, null, null, null));
        Decision d = adapter(client).evaluate(request("fw-off", FlagType.BOOLEAN, JsonValue.of(true)));
        assertEquals(Reasons.DISABLED, d.reason());
        assertEquals(JsonValue.of(false), d.value());
    }

    @Test
    void missingFlagThrowsFlagNotFound() throws Exception {
        FakeClient client = new FakeClient();
        FireweaveException e = assertThrows(FireweaveException.class, () ->
                adapter(client).evaluate(request("nope", FlagType.BOOLEAN, JsonValue.of(false))));
        assertEquals(ErrorKind.FlagNotFound, e.kind());
    }

    @Test
    void typeMismatchOnWrongShape() throws Exception {
        FakeClient client = new FakeClient();
        client.snapshot = snapshotOf(new PostHogFlagsSnapshot.FlagResult(
                "fw-bool", true, "on", null, null, null, null, null, null));
        FireweaveException e = assertThrows(FireweaveException.class, () ->
                adapter(client).evaluate(request("fw-bool", FlagType.INTEGER, JsonValue.of(0))));
        assertEquals(ErrorKind.TypeMismatch, e.kind());
    }

    @Test
    void quotaLimitedServesFlagNotFoundWithMetadata() throws Exception {
        FakeClient client = new FakeClient();
        client.snapshot = new PostHogFlagsSnapshot(Collections.emptyMap(),
                Collections.singletonList("feature_flags"), false, 0);
        FireweaveException e = assertThrows(FireweaveException.class, () ->
                adapter(client).evaluate(request("fw", FlagType.BOOLEAN, JsonValue.of(false))));
        assertEquals(ErrorKind.FlagNotFound, e.kind());
        assertEquals(Boolean.TRUE, e.decisionMetadata().get("fireweave.quotaLimited"));
    }

    @Test
    void transportErrorMapping() {
        assertEquals(ErrorKind.Authentication,
                PostHogAdapter.mapTransport(PostHogTransportException.http(401)).kind());
        assertEquals(ErrorKind.Authorization,
                PostHogAdapter.mapTransport(PostHogTransportException.http(403)).kind());
        assertEquals(ErrorKind.RateLimited,
                PostHogAdapter.mapTransport(PostHogTransportException.http(429)).kind());
        assertEquals(ErrorKind.BackendUnavailable,
                PostHogAdapter.mapTransport(PostHogTransportException.http(500)).kind());
        assertEquals(ErrorKind.Timeout,
                PostHogAdapter.mapTransport(PostHogTransportException.timeout()).kind());
        assertEquals(ErrorKind.Network,
                PostHogAdapter.mapTransport(PostHogTransportException.network(null)).kind());
        assertEquals(ErrorKind.MalformedResponse,
                PostHogAdapter.mapTransport(PostHogTransportException.malformedBody()).kind());
    }

    @Test
    void missingDistinctIdRejected() throws Exception {
        FakeClient client = new FakeClient();
        PostHogAdapter a = adapter(client);
        FireweaveException e = assertThrows(FireweaveException.class, () ->
                a.evaluate(new EvaluationRequest("fw", FlagType.BOOLEAN, JsonValue.of(false),
                        EvaluationContext.empty(), EvaluationOptions.defaults())));
        assertEquals("TARGETING_KEY_MISSING", e.openFeatureErrorCode());
    }

    @Test
    void staleSnapshotSurfacesStaleReasonAndFlag() throws Exception {
        FakeClient client = new FakeClient();
        Map<String, PostHogFlagsSnapshot.FlagResult> flags = new LinkedHashMap<>();
        flags.put("fw-stale", new PostHogFlagsSnapshot.FlagResult(
                "fw-stale", true, "on", null, null, null, null, null, null));
        client.snapshot = new PostHogFlagsSnapshot(flags, Collections.emptyList(), false,
                PostHogAdapter.DEFAULT_STALE_THRESHOLD_MS + 1);
        PostHogAdapter a = adapter(client);
        Decision d = a.evaluate(request("fw-stale", FlagType.BOOLEAN, JsonValue.of(false)));
        assertEquals(Reasons.STALE, d.reason());
        assertEquals(Boolean.TRUE, d.flagMetadata().get("fireweave.fromCache"));
        assertTrue(a.isStale());
    }

    @Test
    void exposureDedupAndCapture() throws Exception {
        FakeClient client = new FakeClient();
        PostHogAdapter a = adapter(client);
        Exposure e = new Exposure("user_1", "fw", "on", JsonValue.of(true), null);
        a.deliverExposure(e);
        a.deliverExposure(e); // duplicate — must not re-capture
        assertEquals(1, client.capturedEvents.size());
        assertEquals("$feature_flag_called", client.capturedEvents.get(0));
    }

    @Test
    void exposureDedupClearedOnFlush() throws Exception {
        // Ratified clear-on-flush lifecycle (security review M-2): the dedup set is scoped to
        // one flush window and can never grow unbounded across a long-lived process.
        FakeClient client = new FakeClient();
        PostHogAdapter a = adapter(client);
        Exposure e = new Exposure("user_1", "fw", "on", JsonValue.of(true), null);
        a.deliverExposure(e);
        a.deliverExposure(e);
        assertEquals(1, client.capturedEvents.size());
        a.onExposuresFlushed(); // flush window closes
        a.deliverExposure(e);
        assertEquals(2, client.capturedEvents.size(), "new flush window re-delivers");
    }

    @Test
    void injectedClientNotClosedOwnedClientClosed() throws Exception {
        FakeClient injected = new FakeClient();
        PostHogAdapter a = new PostHogAdapter(injected);
        a.initialize(FireweaveConfig.builder().projectApiKey("phc_K0000000000000000000000001").build());
        a.shutdown();
        assertFalse(injected.closed, "injected client must not be closed by adapter");

        FakeClient owned = new FakeClient();
        PostHogAdapter b = new PostHogAdapter(owned, true, PostHogAdapter.DEFAULT_STALE_THRESHOLD_MS);
        b.initialize(FireweaveConfig.builder().projectApiKey("phc_K0000000000000000000000002").build());
        b.shutdown();
        assertTrue(owned.closed, "owned client must be closed on shutdown");
    }

    @Test
    void localEvalRequiresPersonalKey() {
        FakeClient client = new FakeClient();
        PostHogAdapter a = new PostHogAdapter(client);
        FireweaveException e = assertThrows(FireweaveException.class, () ->
                a.initialize(FireweaveConfig.builder()
                        .projectApiKey("phc_K0000000000000000000000003")
                        .localEvaluation(true).build()));
        assertEquals(ErrorKind.Configuration, e.kind());
        assertNull(nullIfNoSecret(e.getMessage()), "no secret in message");
    }

    @Test
    void configOwnedConstructionIsBlockedWithClearError() {
        FireweaveException e = assertThrows(FireweaveException.class, () ->
                PostHogAdapter.create(FireweaveConfig.builder().build()));
        assertEquals(ErrorKind.UnsupportedCapability, e.kind());
        assertTrue(e.getMessage().contains("posthog-server"));
    }

    private static String nullIfNoSecret(String msg) {
        return ai.fireweave.sdk.Redaction.containsSecret(msg) ? msg : null;
    }
}
