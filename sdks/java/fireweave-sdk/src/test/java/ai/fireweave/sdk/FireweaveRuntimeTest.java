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

    private static void assertHostAccepted(String host) throws Exception {
        new FireweaveRuntime(FireweaveConfig.builder().host(host).build(), new StubAdapter())
                .initialize();
    }

    private static void assertHostRejected(FireweaveConfig config) {
        FireweaveException e = assertThrows(FireweaveException.class,
                () -> new FireweaveRuntime(config, new StubAdapter()).initialize());
        assertEquals(ErrorKind.Configuration, e.kind());
    }

    @Test
    void defaultAllowlistIsTheCanonicalCrossLanguageList() throws Exception {
        assertEquals(java.util.Set.of(
                        "app.posthog.com", "us.posthog.com", "eu.posthog.com",
                        "us.i.posthog.com", "eu.i.posthog.com",
                        "localhost", "127.0.0.1", "::1"),
                FireweaveConfig.DEFAULT_ALLOWED_HOSTS);
        for (String h : new String[] {
                "https://app.posthog.com", "https://us.posthog.com", "https://eu.posthog.com",
                "https://us.i.posthog.com", "https://eu.i.posthog.com"}) {
            assertHostAccepted(h);
        }
    }

    @Test
    void httpAllowedOnLoopbackOnly() throws Exception {
        assertHostAccepted("http://127.0.0.1:3901");
        assertHostAccepted("http://localhost:3901");
        assertHostAccepted("http://[::1]:3901");
        // https-only for non-loopback hosts, even when allowlisted (L-3).
        assertHostRejected(FireweaveConfig.builder().host("http://us.i.posthog.com").build());
        assertHostRejected(FireweaveConfig.builder().host("ftp://us.i.posthog.com").build());
    }

    @Test
    void customHostsRequireExplicitAllowlistConfig() throws Exception {
        // Not on the canonical default list → denied by default.
        assertHostRejected(FireweaveConfig.builder().host("https://posthog.internal.example").build());
        // Explicitly allowlisted self-hosted instance → accepted.
        new FireweaveRuntime(FireweaveConfig.builder()
                .host("https://posthog.internal.example")
                .allowedHosts(java.util.Set.of("posthog.internal.example"))
                .build(), new StubAdapter()).initialize();
        // Explicit "*" opt-out allows any host but never plain http off-loopback.
        new FireweaveRuntime(FireweaveConfig.builder()
                .host("https://posthog.internal.example")
                .allowedHosts(java.util.Set.of(FireweaveConfig.ALLOW_ANY_HOST))
                .build(), new StubAdapter()).initialize();
        assertHostRejected(FireweaveConfig.builder()
                .host("http://posthog.internal.example")
                .allowedHosts(java.util.Set.of(FireweaveConfig.ALLOW_ANY_HOST))
                .build());
        // Empty allowlist is deny-all, not allow-all.
        assertHostRejected(FireweaveConfig.builder()
                .host("https://us.i.posthog.com")
                .allowedHosts(java.util.Collections.emptySet())
                .build());
    }

    @Test
    void shutdownDeadlineFromConfigIsEnforced() throws Exception {
        StubAdapter adapter = new StubAdapter();
        adapter.shutdownBlocksForever = true;
        FireweaveRuntime rt = new FireweaveRuntime(
                FireweaveConfig.builder().shutdownTimeoutMs(100).build(), adapter);
        rt.initialize();
        long start = System.nanoTime();
        rt.shutdown(); // must not hang on the wedged adapter
        long elapsedMs = (System.nanoTime() - start) / 1_000_000;
        assertTrue(elapsedMs < 5_000, "bounded shutdown, took " + elapsedMs + "ms");
        assertEquals(LifecycleState.SHUTDOWN, rt.state());
        assertEquals(ErrorKind.Timeout, rt.lastError().kind());
    }

    @Test
    void promptShutdownLeavesNoError() throws Exception {
        StubAdapter adapter = new StubAdapter();
        FireweaveRuntime rt = new FireweaveRuntime(
                FireweaveConfig.builder().shutdownTimeoutMs(2_000).build(), adapter);
        rt.initialize();
        rt.shutdown();
        assertEquals(1, adapter.shutdownCalls, "adapter shutdown completed within deadline");
        assertNull(rt.lastError());
    }

    @Test
    void canonicalFireweaveGroupsKeysReachAdapterAsFirstClassGroups() throws Exception {
        StubAdapter adapter = new StubAdapter();
        final EvaluationContext[] seen = new EvaluationContext[1];
        adapter.onEvaluate = req -> {
            seen[0] = req.context();
            return Decision.builder(req.flagKey()).value(JsonValue.of(true))
                    .reason(Reasons.TARGETING_MATCH).build();
        };
        FireweaveRuntime rt = runtime(adapter);
        rt.initialize();
        EvaluationContext ctx = EvaluationContext.builder().targetingKey("user_1")
                .attribute("fireweave.groups", JsonValue.ofObject(
                        java.util.Map.of("organization", JsonValue.of("org_1"))))
                .attribute("fireweave.groupProperties", JsonValue.ofObject(
                        java.util.Map.of("organization", JsonValue.ofObject(
                                java.util.Map.of("plan", JsonValue.of("enterprise"))))))
                .build();
        Decision d = rt.evaluate("f", FlagType.BOOLEAN, JsonValue.of(false), null, ctx, null);
        assertNull(d.error());
        assertEquals("org_1", seen[0].groups().get("organization"));
        assertEquals(JsonValue.of("enterprise"),
                seen[0].groupProperties().get("organization").get("plan"));
        assertTrue(!seen[0].attributes().containsKey("fireweave.groups"),
                "canonical key promoted out of plain attributes");

        // Any other fireweave.* key still degrades to InvalidContext (ruling 13).
        Decision rejected = rt.evaluate("f", FlagType.BOOLEAN, JsonValue.of(false), null,
                EvaluationContext.builder().targetingKey("user_1")
                        .attribute("fireweave.evaluationContexts", "beta").build(), null);
        assertEquals("INVALID_CONTEXT", rejected.error().openFeatureErrorCode());
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
    void sendExposureDefaultEmitsOnSuccessfulEvaluate() throws Exception {
        StubAdapter adapter = new StubAdapter();
        FireweaveRuntime rt = runtime(adapter);
        rt.initialize();
        EvaluationContext ctx = EvaluationContext.builder().targetingKey("user_1").build();
        Decision d = rt.evaluate("checkout", FlagType.BOOLEAN, JsonValue.of(false), null, ctx, null);
        assertNull(d.error());
        assertTrue(d.exposureEmitted());
        assertEquals(1, adapter.exposures.size());
        assertEquals("checkout", adapter.exposures.get(0).flagKey());
        assertEquals("user_1", adapter.exposures.get(0).targetingKey());
    }

    @Test
    void sendExposureFalseSuppressesDelivery() throws Exception {
        StubAdapter adapter = new StubAdapter();
        FireweaveRuntime rt = runtime(adapter);
        rt.initialize();
        EvaluationContext ctx = EvaluationContext.builder().targetingKey("user_1").build();
        Decision d = rt.evaluate("checkout", FlagType.BOOLEAN, JsonValue.of(false), null, ctx,
                EvaluationOptions.builder().sendExposure(false).build());
        assertNull(d.error());
        assertTrue(d.exposureSuppressed());
        assertTrue(!d.exposureEmitted());
        assertEquals(0, adapter.exposures.size());
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
