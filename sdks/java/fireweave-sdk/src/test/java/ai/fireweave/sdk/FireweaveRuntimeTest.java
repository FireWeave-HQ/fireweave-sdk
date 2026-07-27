package ai.fireweave.sdk;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class FireweaveRuntimeTest {

    private static FireweaveRuntime runtime(StubAdapter adapter) {
        return new FireweaveRuntime(FireweaveConfig.builder().build(), adapter);
    }

    @Test
    void lifecycleHappyPath() throws Exception {
        StubAdapter adapter = new StubAdapter();
        FireweaveRuntime rt = runtime(adapter);
        assertEquals(LifecycleState.UNINITIALIZED, rt.state());
        rt.initialize();
        assertEquals(LifecycleState.READY, rt.state());
        rt.shutdown();
        assertEquals(LifecycleState.SHUTDOWN, rt.state());
        rt.shutdown(); // idempotent
        assertEquals(1, adapter.shutdownCalls);
    }

    @Test
    void evaluateBeforeInitReturnsNotReadyDefault() {
        FireweaveRuntime rt = runtime(new StubAdapter());
        Decision d = rt.evaluate("f", FlagType.BOOLEAN, JsonValue.of(false), null, null, null);
        assertEquals(JsonValue.of(false), d.value());
        assertEquals(Reasons.ERROR, d.reason());
        assertEquals(ErrorKind.NotReady, d.error().kind());
        assertEquals("PROVIDER_NOT_READY", d.error().openFeatureErrorCode());
        assertEquals("NotReady", d.flagMetadata().get("fireweave.errorKind"));
    }

    @Test
    void evaluateAfterShutdownReturnsAlreadyClosedDefault() throws Exception {
        FireweaveRuntime rt = runtime(new StubAdapter());
        rt.initialize();
        rt.shutdown();
        Decision d = rt.evaluate("f", FlagType.BOOLEAN, JsonValue.of(false), null, null, null);
        assertEquals(ErrorKind.AlreadyClosed, d.error().kind());
        assertEquals("PROVIDER_NOT_READY", d.error().openFeatureErrorCode());
        assertEquals("provider already closed", d.error().message());
    }

    @Test
    void configurationFailureIsFatal() {
        StubAdapter adapter = new StubAdapter();
        FireweaveRuntime rt = new FireweaveRuntime(
                FireweaveConfig.builder().projectApiKey("").host("not-a-uri").build(), adapter);
        FireweaveException e = assertThrows(FireweaveException.class, rt::initialize);
        assertEquals(ErrorKind.Configuration, e.kind());
        assertEquals(LifecycleState.FATAL, rt.state());
        assertEquals("PROVIDER_FATAL", rt.lastError().openFeatureErrorCode());
    }

    @Test
    void ssrfAllowlistRejectsUnknownHost() {
        FireweaveRuntime rt = new FireweaveRuntime(
                FireweaveConfig.builder().projectApiKey("phc_SECRET123").host("http://169.254.169.254").build(),
                new StubAdapter());
        FireweaveException e = assertThrows(FireweaveException.class, rt::initialize);
        assertEquals(ErrorKind.Configuration, e.kind());
        assertTrue(!e.getMessage().contains("phc_"), "no secret echo");
    }

    @Test
    void transientInitFailureIsErrorNotFatal() {
        StubAdapter adapter = new StubAdapter();
        adapter.initFailure = new FireweaveException(ErrorKind.Network);
        FireweaveRuntime rt = runtime(adapter);
        assertThrows(FireweaveException.class, rt::initialize);
        assertEquals(LifecycleState.ERROR, rt.state());
    }

    @Test
    void adapterErrorsDegradeToDefaultNeverThrow() throws Exception {
        StubAdapter adapter = new StubAdapter();
        FireweaveRuntime rt = runtime(adapter);
        rt.initialize();
        adapter.evalFailure = FireweaveException.quotaLimited();
        Decision d = rt.evaluate("f", FlagType.BOOLEAN, JsonValue.of(false), null, null, null);
        assertEquals(Reasons.ERROR, d.reason());
        assertEquals("FLAG_NOT_FOUND", d.error().openFeatureErrorCode());
        assertEquals(Boolean.TRUE, d.flagMetadata().get("fireweave.quotaLimited"));
    }

    @Test
    void invalidContextRejectedBeforeAdapter() throws Exception {
        StubAdapter adapter = new StubAdapter();
        final boolean[] called = {false};
        adapter.onEvaluate = req -> {
            called[0] = true;
            return Decision.builder(req.flagKey()).value(JsonValue.of(true)).build();
        };
        FireweaveRuntime rt = new FireweaveRuntime(
                FireweaveConfig.builder().requireTargetingKey(true).build(), adapter);
        rt.initialize();
        Decision d = rt.evaluate("f", FlagType.BOOLEAN, JsonValue.of(false), null,
                EvaluationContext.empty(), null);
        assertEquals("TARGETING_KEY_MISSING", d.error().openFeatureErrorCode());
        assertEquals(false, called[0], "adapter must not be called for invalid context");
    }

    @Test
    void payloadMetadataOnlyWhenRequested() throws Exception {
        StubAdapter adapter = new StubAdapter();
        adapter.onEvaluate = req -> Decision.builder(req.flagKey())
                .value(JsonValue.of(true)).variant("on").reason(Reasons.TARGETING_MATCH)
                .payload(JsonValue.ofObject(java.util.Map.of("b", JsonValue.of(2), "a", JsonValue.of(1))))
                .build();
        FireweaveRuntime rt = runtime(adapter);
        rt.initialize();

        Decision plain = rt.evaluate("f", FlagType.BOOLEAN, JsonValue.of(false), null, null, null);
        assertNull(plain.flagMetadata().get("fireweave.payload"));

        Decision with = rt.evaluate("f", FlagType.BOOLEAN, JsonValue.of(false), null, null,
                EvaluationOptions.builder().includePayloadMetadata(true).build());
        assertEquals("{\"a\":1,\"b\":2}", with.flagMetadata().get("fireweave.payload"));
    }

    @Test
    void allowedLifecycleTransitions() {
        assertTrue(LifecycleState.UNINITIALIZED.canTransitionTo(LifecycleState.INITIALIZING));
        assertTrue(LifecycleState.READY.canTransitionTo(LifecycleState.STALE));
        assertTrue(LifecycleState.STALE.canTransitionTo(LifecycleState.READY));
        assertTrue(LifecycleState.FATAL.canTransitionTo(LifecycleState.SHUTDOWN));
        assertTrue(!LifecycleState.SHUTDOWN.canTransitionTo(LifecycleState.READY));
        assertTrue(!LifecycleState.FATAL.canTransitionTo(LifecycleState.READY));
    }
}
