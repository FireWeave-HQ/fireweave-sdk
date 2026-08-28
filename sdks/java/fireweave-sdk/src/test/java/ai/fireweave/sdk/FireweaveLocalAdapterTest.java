package ai.fireweave.sdk;

import ai.fireweave.sdk.application.EvaluationOptions;
import ai.fireweave.sdk.application.EvaluationRequest;
import ai.fireweave.sdk.application.FireweaveConfig;
import ai.fireweave.sdk.application.FireweaveRuntime;
import ai.fireweave.sdk.application.RegisterTargetOptions;
import ai.fireweave.sdk.application.RegisterTargetResult;
import ai.fireweave.sdk.domain.Decision;
import ai.fireweave.sdk.domain.ErrorKind;
import ai.fireweave.sdk.domain.EvaluationContext;
import ai.fireweave.sdk.domain.FireweaveException;
import ai.fireweave.sdk.domain.FlagType;
import ai.fireweave.sdk.domain.JsonValue;
import ai.fireweave.sdk.domain.LifecycleState;
import ai.fireweave.sdk.domain.Reasons;
import ai.fireweave.sdk.domain.TargetKind;
import ai.fireweave.sdk.infrastructure.adapters.FireweaveLocalAdapter;
import ai.fireweave.sdk.infrastructure.adapters.LocalRegisteredTarget;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

final class FireweaveLocalAdapterTest {

    @Test
    void nameIsOther() {
        FireweaveLocalAdapter adapter = new FireweaveLocalAdapter(Map.of("a", true));
        assertEquals("other", adapter.name());
    }

    /**
     * spec/modes.md "Behaviour per mode": local mode's unknown-key row is
     * default/reason DEFAULT — deliberately NOT an error, unlike remote's
     * default/ERROR/FlagNotFound (FireweaveRemoteAdapterTest / RegisterTargetTest cover the
     * remote side). This is the strict, typed seam: a miss RETURNS a plain Decision rather than
     * throwing, so the runtime can never confuse "no decision for this key" with "the backend
     * failed".
     */
    @Test
    void missReturnsDefaultReasonNotAnError() throws Exception {
        FireweaveLocalAdapter adapter = new FireweaveLocalAdapter(Map.of("fw-on", true));
        adapter.initialize(FireweaveConfig.builder().build());
        EvaluationContext ctx = EvaluationContext.builder().targetingKey("u").build();

        Decision miss = adapter.evaluate(new EvaluationRequest("fw-missing", FlagType.BOOLEAN,
                JsonValue.of(false), ctx, EvaluationOptions.defaults()));
        assertEquals(Reasons.DEFAULT, miss.reason());
        assertEquals(JsonValue.of(false), miss.value());
        assertEquals(null, miss.error(), "a DEFAULT decision is not an error decision");

        Decision hit = adapter.evaluate(new EvaluationRequest("fw-on", FlagType.BOOLEAN,
                JsonValue.of(false), ctx, EvaluationOptions.defaults()));
        assertTrue(hit.value().asBoolean());
        assertEquals(Reasons.STATIC, hit.reason());
        assertEquals("on", hit.variant());
        adapter.shutdown();
    }

    @Test
    void typeMismatchOnNonBooleanRead() throws Exception {
        FireweaveLocalAdapter adapter = new FireweaveLocalAdapter(Map.of("fw-on", true));
        adapter.initialize(FireweaveConfig.builder().build());
        FireweaveException e = assertThrows(FireweaveException.class, () ->
                adapter.evaluate(new EvaluationRequest("fw-on", FlagType.STRING,
                        JsonValue.of("x"),
                        EvaluationContext.builder().targetingKey("u").build(),
                        EvaluationOptions.defaults())));
        assertEquals(ErrorKind.TypeMismatch, e.kind());
        adapter.shutdown();
    }

    @Test
    void closedAdapterStillThrowsAlreadyClosed() throws Exception {
        FireweaveLocalAdapter adapter = new FireweaveLocalAdapter(Map.of("fw-on", true));
        adapter.initialize(FireweaveConfig.builder().build());
        adapter.shutdown();
        FireweaveException e = assertThrows(FireweaveException.class, () ->
                adapter.evaluate(new EvaluationRequest("fw-on", FlagType.BOOLEAN,
                        JsonValue.of(false),
                        EvaluationContext.builder().targetingKey("u").build(),
                        EvaluationOptions.defaults())));
        assertEquals(ErrorKind.AlreadyClosed, e.kind());
    }

    @Test
    void composesWithRuntimeMissIsDefaultNotError() throws Exception {
        FireweaveRuntime runtime = new FireweaveRuntime(
                FireweaveConfig.builder().build(),
                new FireweaveLocalAdapter(Map.of("fw-on", true)));
        runtime.initialize();
        assertEquals(LifecycleState.READY, runtime.state());
        Decision d = runtime.evaluate("fw-on", FlagType.BOOLEAN, JsonValue.of(false),
                null, EvaluationContext.builder().targetingKey("u").build(), null);
        assertTrue(d.value().asBoolean());
        assertEquals(Reasons.STATIC, d.reason());

        Decision miss = runtime.evaluate("fw-missing", FlagType.BOOLEAN, JsonValue.of(false),
                null, EvaluationContext.builder().targetingKey("u").build(), null);
        assertFalse(miss.value().asBoolean());
        assertEquals(Reasons.DEFAULT, miss.reason());
        assertEquals(null, miss.error());
        runtime.shutdown();
    }

    @Test
    void falseOverrideIsStaticOffNotDisabled() throws Exception {
        FireweaveLocalAdapter adapter = new FireweaveLocalAdapter(Map.of("fw-off", false));
        adapter.initialize(FireweaveConfig.builder().build());
        Decision d = adapter.evaluate(new EvaluationRequest("fw-off", FlagType.BOOLEAN,
                JsonValue.of(true),
                EvaluationContext.builder().targetingKey("u").build(),
                EvaluationOptions.defaults()));
        assertFalse(d.value().asBoolean());
        assertEquals(Reasons.STATIC, d.reason());
        assertEquals("off", d.variant());
        adapter.shutdown();
    }

    @Test
    void noCredentialsRequired() {
        FireweaveLocalAdapter adapter = new FireweaveLocalAdapter(Collections.emptyMap());
        adapter.initialize(FireweaveConfig.builder().build());
        adapter.shutdown();
    }

    // ------------------------------------------------------------------ registerTarget (local)

    /**
     * spec/modes.md "registerTarget in local mode": records in-process + traces one
     * "[fireweave:local]" line + resolves ok:true — never UnsupportedCapability, and never sent
     * to fw-server.
     */
    @Test
    void registerTargetRecordsInProcessAndTracesOnce() {
        List<String> traced = new ArrayList<>();
        FireweaveLocalAdapter adapter = new FireweaveLocalAdapter(Collections.emptyMap(), traced::add);

        RegisterTargetResult result = adapter.registerTarget("user_42",
                RegisterTargetOptions.builder()
                        .kind(TargetKind.USER)
                        .environment("production")
                        .property("plan", JsonValue.of("enterprise"))
                        .build());

        assertTrue(result.ok());
        assertEquals(1, traced.size(), "exactly one trace line per registerTarget call");
        assertTrue(traced.get(0).startsWith("[fireweave:local]"), traced.get(0));
        assertTrue(traced.get(0).contains("NOT sent to fw-server"), traced.get(0));
        assertTrue(traced.get(0).contains("user_42"), traced.get(0));

        List<LocalRegisteredTarget> targets = adapter.getRegisteredTargets();
        assertEquals(1, targets.size());
        assertEquals("user_42", targets.get(0).targetingKey());
        assertEquals(TargetKind.USER, targets.get(0).kind());
        assertEquals("production", targets.get(0).environment());
        assertEquals(JsonValue.of("enterprise"), targets.get(0).properties().get("plan"));
    }

    @Test
    void registerTargetDefaultsKindToUserAndDefaultsLogSink() {
        // No log sink injected: must not throw (defaults to System.out).
        FireweaveLocalAdapter adapter = new FireweaveLocalAdapter();
        RegisterTargetResult result = adapter.registerTarget("device-1", RegisterTargetOptions.empty());
        assertTrue(result.ok());
        assertEquals(TargetKind.USER, adapter.getRegisteredTargets().get(0).kind());
    }

    @Test
    void registerTargetNeverThrowsAndAlwaysReadableAfterward() {
        FireweaveLocalAdapter adapter = new FireweaveLocalAdapter();
        assertTrue(adapter.registerTarget("a", null).ok());
        assertEquals(1, adapter.getRegisteredTargets().size());
        // Re-registering the same key overwrites, not appends.
        assertTrue(adapter.registerTarget("a", RegisterTargetOptions.empty()).ok());
        assertEquals(1, adapter.getRegisteredTargets().size());
    }
}
