package ai.fireweave.sdk;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.Collections;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class FireweaveClientExtensionsTest {

    private StubAdapter adapter;
    private FireweaveRuntime runtime;
    private FireweaveClient client;

    @BeforeEach
    void setUp() throws Exception {
        adapter = new StubAdapter();
        runtime = new FireweaveRuntime(FireweaveConfig.builder().build(), adapter);
        runtime.initialize();
        client = new FireweaveClient(runtime);
    }

    private static Exposure exposure(String key) {
        return new Exposure("org_1", key, "on", JsonValue.of(true), null);
    }

    @Test
    void exposureDedupOnSubjectFlagVariantValue() {
        assertEquals(1, client.exposures().record(exposure("f1")).value().queued());
        ExtensionResult<FireweaveClient.RecordOutcome> dup = client.exposures().record(exposure("f1"));
        assertEquals(1, dup.value().queued());
        assertTrue(dup.value().deduped());
        // Different value → not a duplicate.
        ExtensionResult<FireweaveClient.RecordOutcome> other = client.exposures().record(
                new Exposure("org_1", "f1", "on", JsonValue.of(false), null));
        assertEquals(2, other.value().queued());
        assertFalse(other.value().deduped());
    }

    @Test
    void flushDrainsToAdapter() {
        client.exposures().record(exposure("f1"));
        client.exposures().record(exposure("f2"));
        ExtensionResult<FireweaveClient.FlushOutcome> r = client.exposures().flush();
        assertEquals(2, r.value().flushed());
        assertEquals(0, r.value().queued());
        assertEquals(2, adapter.exposures.size());
    }

    @Test
    void releasesLifecycle() {
        ReleaseContext rc = ReleaseContext.builder()
                .stampId("stmp_01HZXRE0000000000000000001")
                .rolloutId("rollout_1").changeId("chg_1").build();
        assertTrue(client.releases().setContext(rc).isOk());
        assertEquals("in_progress", client.releases().start("rollout_1").value().status());
        assertEquals("completed", client.releases().complete("rollout_1").value().status());
        ExtensionResult<FireweaveClient.ReleaseStatus> failed =
                client.releases().fail("rollout_1", "guardrail phc_SECRET breach");
        assertEquals("failed", failed.value().status());
        assertFalse(failed.value().reason().contains("phc_"), "reason sanitized");
    }

    @Test
    void signalsRecordedAndSanitized() {
        ExtensionResult<Signal> r = client.signals().recordError(
                "evaluation", ErrorKind.Timeout, "timed out with key phs_SECRET");
        assertTrue(r.isOk());
        assertFalse(adapter.signals.get(0).message().contains("phs_"));
        assertTrue(client.signals().recordHealth("provider", "ok").isOk());
        assertTrue(client.signals().recordMetric("rollout.adoption", JsonValue.of(1)).isOk());
        assertTrue(client.signals().recordOutcome("release", "completed").isOk());
        assertEquals(4, adapter.signals.size());
    }

    @Test
    void telemetryAllowlistFiltersSignalAttributes() throws Exception {
        FireweaveRuntime rt = new FireweaveRuntime(FireweaveConfig.builder()
                .telemetryAttributeAllowlist(Set.of("region")).build(), adapter);
        rt.initialize();
        FireweaveClient c = new FireweaveClient(rt);
        c.signals().record(Signal.builder(Signal.Kind.HEALTH, "provider")
                .status("ok")
                .attribute("region", JsonValue.of("us"))
                .attribute("email", JsonValue.of("pii@example.com"))
                .build());
        Signal recorded = adapter.signals.get(adapter.signals.size() - 1);
        assertEquals(Collections.singleton("region"), recorded.attributes().keySet());
    }

    @Test
    void guardrailsDegradeWithUnsupportedCapability() {
        ExtensionResult<Object> r = client.guardrails().check("latency", Collections.emptyMap());
        assertFalse(r.isOk());
        assertTrue(r.isDegraded());
        assertEquals(ErrorKind.UnsupportedCapability, r.error().kind());
    }

    @Test
    void unknownCapabilityDegrades() {
        ExtensionResult<Object> r = client.invokeCapability("releases.teleport", Collections.emptyMap());
        assertFalse(r.isOk());
        assertTrue(r.isDegraded());
        assertEquals("unsupported capability", r.error().message());
        assertEquals("GENERAL", r.error().openFeatureErrorCode());
    }

    @Test
    void capabilitiesListMatchesContract() {
        Capabilities caps = client.capabilities().get();
        assertEquals(java.util.Arrays.asList(
                "releases.setContext", "releases.start", "releases.complete", "releases.fail",
                "exposures.record", "exposures.flush",
                "signals.recordHealth", "signals.recordError",
                "signals.recordMetric", "signals.recordOutcome",
                "capabilities.get"), caps.names());
        assertEquals("inmemory", caps.backend());
        assertEquals(LifecycleState.READY, caps.lifecycle());
    }

    @Test
    void extensionsFailClosedAfterShutdown() {
        runtime.shutdown();
        assertEquals(ErrorKind.AlreadyClosed, client.exposures().record(exposure("f")).error().kind());
        assertEquals(ErrorKind.AlreadyClosed, client.signals().recordHealth("p", "ok").error().kind());
        assertEquals(ErrorKind.AlreadyClosed,
                client.releases().start("rollout_1").error().kind());
    }

    @Test
    void emptySignalNameRejected() {
        org.junit.jupiter.api.Assertions.assertThrows(IllegalArgumentException.class,
                () -> Signal.builder(Signal.Kind.HEALTH, "").build());
    }
}
