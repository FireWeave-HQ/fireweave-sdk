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
                .rolloutId("rollout_1").changeId("chg_01HZXRE0000000000000000001").build();
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
    void setContextValidatesSchemaRequiredFields() {
        // Ruling 15: exactly spec/release-context.schema.json — rolloutId required.
        ExtensionResult<ReleaseContext> noRollout = client.releases().setContext(
                ReleaseContext.builder().stampId("stmp_01HZXRE0000000000000000001").build());
        assertFalse(noRollout.isOk());
        assertEquals(ErrorKind.InvalidContext, noRollout.error().kind());

        // stampIds required, 1..64 typed Crockford ULIDs.
        ExtensionResult<ReleaseContext> noStamps = client.releases().setContext(
                ReleaseContext.builder().rolloutId("rollout_1").build());
        assertEquals(ErrorKind.InvalidContext, noStamps.error().kind());
        ExtensionResult<ReleaseContext> badStamp = client.releases().setContext(
                ReleaseContext.builder().rolloutId("rollout_1").stampId("stmp_LOL").build());
        assertEquals(ErrorKind.InvalidContext, badStamp.error().kind());

        // changeId optional, but pattern-checked when present.
        ExtensionResult<ReleaseContext> badChange = client.releases().setContext(
                ReleaseContext.builder().rolloutId("rollout_1")
                        .stampId("stmp_01HZXRE0000000000000000001")
                        .changeId("chg_1").build());
        assertEquals(ErrorKind.InvalidContext, badChange.error().kind());

        // Nothing bound after the rejections; a schema-valid context is accepted.
        org.junit.jupiter.api.Assertions.assertNull(client.releases().currentContext());
        assertTrue(client.releases().setContext(ReleaseContext.builder()
                .rolloutId("rollout_1")
                .stampId("stmp_01HZXRE0000000000000000001")
                .changeId("chg_01HZXRE0000000000000000001").build()).isOk());
    }

    @Test
    void adapterDedupWindowClearedOnFlush() {
        // Clear-on-flush lifecycle (ratified): re-recording after a flush re-queues and
        // re-delivers — dedup scope is one flush window.
        client.exposures().record(exposure("f1"));
        assertEquals(1, client.exposures().flush().value().flushed());
        ExtensionResult<FireweaveClient.RecordOutcome> again = client.exposures().record(exposure("f1"));
        assertFalse(again.value().deduped());
        assertEquals(1, again.value().queued());
        assertEquals(1, client.exposures().flush().value().flushed());
        assertEquals(2, adapter.exposures.size(), "delivered once per flush window");
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
    void extensionsGatedBeforeReadyAndDeliverOnlyThroughAdapterSink() throws Exception {
        // Ruling 17 canonical model (Go/Java, pinned by ext-lifecycle-gating): extension calls
        // are lifecycle-gated and delivered to the adapter sink; pre-ready calls degrade
        // predictably (UnsupportedCapability, degraded, never throw) and nothing reaches the sink.
        StubAdapter gatedAdapter = new StubAdapter();
        FireweaveRuntime gatedRuntime =
                new FireweaveRuntime(FireweaveConfig.builder().build(), gatedAdapter);
        FireweaveClient gated = new FireweaveClient(gatedRuntime);

        ExtensionResult<FireweaveClient.RecordOutcome> preReady = gated.exposures().record(exposure("f"));
        assertEquals(ErrorKind.UnsupportedCapability, preReady.error().kind());
        assertTrue(preReady.isDegraded());
        assertEquals(ErrorKind.UnsupportedCapability, gated.exposures().flush().error().kind());
        assertEquals(ErrorKind.UnsupportedCapability,
                gated.signals().recordHealth("p", "ok").error().kind());
        assertEquals(ErrorKind.UnsupportedCapability, gated.releases().setContext(ReleaseContext.builder()
                .rolloutId("rollout_1").stampId("stmp_01HZXRE0000000000000000001").build())
                .error().kind());
        assertEquals(ErrorKind.UnsupportedCapability, gated.releases().start("rollout_1").error().kind());
        assertTrue(gatedAdapter.exposures.isEmpty(), "no sink delivery before READY");
        assertTrue(gatedAdapter.signals.isEmpty(), "no sink delivery before READY");

        // Once READY, the same calls deliver to the adapter sink.
        gatedRuntime.initialize();
        gated.exposures().record(exposure("f"));
        gated.exposures().flush();
        gated.signals().recordHealth("p", "ok");
        assertEquals(1, gatedAdapter.exposures.size());
        assertEquals(1, gatedAdapter.signals.size());

        // Post-shutdown degrades with AlreadyClosed and stops sink delivery.
        gatedRuntime.shutdown();
        assertEquals(ErrorKind.AlreadyClosed, gated.signals().recordHealth("p", "ok").error().kind());
        assertEquals(1, gatedAdapter.signals.size(), "no sink delivery after shutdown");
    }

    @Test
    void emptySignalNameRejected() {
        org.junit.jupiter.api.Assertions.assertThrows(IllegalArgumentException.class,
                () -> Signal.builder(Signal.Kind.HEALTH, "").build());
    }
}
