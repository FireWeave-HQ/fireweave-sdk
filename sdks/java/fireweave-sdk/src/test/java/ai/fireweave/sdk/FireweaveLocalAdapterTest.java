package ai.fireweave.sdk;

import org.junit.jupiter.api.Test;

import java.util.Collections;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

final class FireweaveLocalAdapterTest {

    @Test
    void features() {
        FireweaveLocalAdapter adapter = new FireweaveLocalAdapter(Map.of("a", true));
        Map<String, Boolean> f = adapter.runtimeFeatures();
        assertEquals(Boolean.TRUE, f.get("localOnly"));
        assertEquals(Boolean.FALSE, f.get("remoteEvaluation"));
        assertEquals(Boolean.TRUE, f.get("sideEffectFreeReads"));
        assertEquals("other", adapter.name());
    }

    @Test
    void missAndHit() throws Exception {
        FireweaveLocalAdapter adapter = new FireweaveLocalAdapter(Map.of("fw-on", true));
        adapter.initialize(FireweaveConfig.builder().build());
        EvaluationContext ctx = EvaluationContext.builder().targetingKey("u").build();
        FireweaveException miss = assertThrows(FireweaveException.class, () ->
                adapter.evaluate(new EvaluationRequest("fw-missing", FlagType.BOOLEAN,
                        JsonValue.of(false), ctx, EvaluationOptions.defaults())));
        assertEquals(ErrorKind.FlagNotFound, miss.kind());

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
    void composesWithRuntime() throws Exception {
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
        assertEquals(Reasons.ERROR, miss.reason());
        assertEquals(ErrorKind.FlagNotFound, miss.error().kind());
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
}
