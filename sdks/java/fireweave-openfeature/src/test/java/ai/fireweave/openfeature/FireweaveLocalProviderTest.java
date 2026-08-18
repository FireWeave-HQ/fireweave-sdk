package ai.fireweave.openfeature;

import ai.fireweave.sdk.EvaluationContext;
import ai.fireweave.sdk.FireweaveLocalAdapter;
import ai.fireweave.sdk.FireweaveRuntime;
import ai.fireweave.sdk.FlagType;
import ai.fireweave.sdk.JsonValue;
import ai.fireweave.sdk.Reasons;
import dev.openfeature.sdk.ErrorCode;
import dev.openfeature.sdk.ImmutableContext;
import dev.openfeature.sdk.MutableContext;
import dev.openfeature.sdk.OpenFeatureAPI;
import dev.openfeature.sdk.ProviderEvaluation;
import dev.openfeature.sdk.Value;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class FireweaveLocalProviderTest {

    private static final MutableContext CTX = new MutableContext("user_42");

    @BeforeEach
    @AfterEach
    void clearCaptures() {
        FireweaveLocalProvider.resetCaptures();
    }

    private static FireweaveLocalProvider provider(Map<String, Boolean> flags) {
        FireweaveLocalProvider p = FireweaveLocalProvider.create(flags);
        p.initialize(new ImmutableContext());
        return p;
    }

    private static FireweaveLocalProvider provider(FireweaveLocalProvider.Options options) {
        FireweaveLocalProvider p = FireweaveLocalProvider.create(options);
        p.initialize(new ImmutableContext());
        return p;
    }

    @Test
    void unknownControlPointResolvesToDefaultCleanly() {
        FireweaveLocalProvider p = provider(Map.of());
        ProviderEvaluation<Boolean> d = p.getBooleanEvaluation("fw-unconfigured", false, CTX);
        assertEquals(false, d.getValue());
        assertEquals(Reasons.DEFAULT, d.getReason());
        assertNull(d.getErrorCode());
        assertEquals("default", d.getVariant());
        p.shutdown();
    }

    @Test
    void callSiteDefaultHonoured() {
        FireweaveLocalProvider p = provider(Map.of());
        ProviderEvaluation<Boolean> d = p.getBooleanEvaluation("fw-unconfigured", true, CTX);
        assertEquals(true, d.getValue());
        assertEquals(Reasons.DEFAULT, d.getReason());
        assertNull(d.getErrorCode());
        p.shutdown();
    }

    @Test
    void devFlagsTrueStatic() {
        FireweaveLocalProvider p = provider(Map.of("fw-checkout", true));
        ProviderEvaluation<Boolean> d = p.getBooleanEvaluation("fw-checkout", false, CTX);
        assertEquals(true, d.getValue());
        assertEquals(Reasons.STATIC, d.getReason());
        assertEquals("on", d.getVariant());
        assertNull(d.getErrorCode());
        p.shutdown();
    }

    @Test
    void devFlagsFalseForcesOff() {
        FireweaveLocalProvider p = provider(Map.of("fw-checkout", false));
        ProviderEvaluation<Boolean> d = p.getBooleanEvaluation("fw-checkout", true, CTX);
        assertEquals(false, d.getValue());
        assertEquals(Reasons.STATIC, d.getReason());
        assertEquals("off", d.getVariant());
        p.shutdown();
    }

    @Test
    void stringIntegerDoubleObjectDefaults() {
        FireweaveLocalProvider p = provider(Map.of());
        ProviderEvaluation<String> s = p.getStringEvaluation("fw-copy", "fallback", CTX);
        ProviderEvaluation<Integer> n = p.getIntegerEvaluation("fw-limit", 7, CTX);
        ProviderEvaluation<Double> f = p.getDoubleEvaluation("fw-ratio", 0.5, CTX);
        ProviderEvaluation<Value> o = p.getObjectEvaluation("fw-config", new Value("fallback"), CTX);
        assertEquals("fallback", s.getValue());
        assertEquals(Reasons.DEFAULT, s.getReason());
        assertNull(s.getErrorCode());
        assertEquals(7, n.getValue());
        assertEquals(Reasons.DEFAULT, n.getReason());
        assertEquals(0.5, f.getValue());
        assertEquals(Reasons.DEFAULT, f.getReason());
        assertEquals(Reasons.DEFAULT, o.getReason());
        assertNull(o.getErrorCode());
        p.shutdown();
    }

    @Test
    void capturesAndReset() {
        FireweaveLocalProvider p = provider(FireweaveLocalProvider.Options.builder()
                .devFlags(Map.of("fw-on", true))
                .now(() -> 1234L)
                .build());
        p.getBooleanEvaluation("fw-on", false, CTX);
        p.getStringEvaluation("fw-copy", "x", CTX);
        List<FwLocalCapture> caps = FireweaveLocalProvider.getCaptures();
        assertEquals(2, caps.size());
        assertEquals("fw-on", caps.get(0).flagKey());
        assertEquals("boolean", caps.get(0).type());
        assertEquals(true, caps.get(0).value());
        assertEquals(Reasons.STATIC, caps.get(0).reason());
        assertEquals(1234L, caps.get(0).ts());
        assertEquals("fw-copy", caps.get(1).flagKey());
        assertEquals("string", caps.get(1).type());
        assertEquals("x", caps.get(1).value());
        assertEquals(Reasons.DEFAULT, caps.get(1).reason());
        FireweaveLocalProvider.resetCaptures();
        assertEquals(0, FireweaveLocalProvider.getCaptures().size());
        p.shutdown();
    }

    @Test
    void echoPrintsWhenEnabled() {
        PrintStream original = System.out;
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        System.setOut(new PrintStream(buf, true, StandardCharsets.UTF_8));
        try {
            FireweaveLocalProvider p = provider(FireweaveLocalProvider.Options.builder()
                    .echo(true)
                    .devFlags(Map.of("fw-on", true))
                    .build());
            p.getBooleanEvaluation("fw-on", false, CTX);
            String out = buf.toString(StandardCharsets.UTF_8);
            assertTrue(out.contains("[fw-local]"));
            assertTrue(out.contains("fw-on"));
            p.shutdown();
        } finally {
            System.setOut(original);
        }
    }

    @Test
    void echoSilentByDefault() {
        PrintStream original = System.out;
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        System.setOut(new PrintStream(buf, true, StandardCharsets.UTF_8));
        try {
            FireweaveLocalProvider p = provider(Map.of());
            p.getBooleanEvaluation("fw-quiet", false, CTX);
            assertEquals("", buf.toString(StandardCharsets.UTF_8));
            p.shutdown();
        } finally {
            System.setOut(original);
        }
    }

    @Test
    void realErrorsNotRewritten() {
        FireweaveLocalProvider p = provider(Map.of());
        p.shutdown();
        ProviderEvaluation<Boolean> d = p.getBooleanEvaluation("fw-anything", false, CTX);
        assertEquals(Reasons.ERROR, d.getReason());
        assertEquals(ErrorCode.PROVIDER_NOT_READY, d.getErrorCode());
    }

    @Test
    void metadataNameIsFireweaveLocal() {
        FireweaveLocalProvider p = provider(Map.of());
        assertEquals("fireweave-local", p.getMetadata().getName());
        p.shutdown();
    }

    @Test
    void openFeatureClient() {
        OpenFeatureAPI api = OpenFeatureAPI.getInstance();
        api.setProviderAndWait("local-test",
                FireweaveLocalProvider.create(Map.of("fw-on", true)));
        assertEquals(true, api.getClient("local-test").getBooleanValue("fw-on", false, CTX));
        assertEquals(false, api.getClient("local-test").getBooleanValue("fw-unconfigured", false, CTX));
        var details = api.getClient("local-test").getBooleanDetails("fw-unconfigured", true, CTX);
        assertEquals(true, details.getValue());
        assertEquals(Reasons.DEFAULT, details.getReason());
        assertNull(details.getErrorCode());
        api.shutdown();
    }

    @Test
    void nativeRuntimePathKeepsFlagNotFound() throws Exception {
        FireweaveRuntime runtime = new FireweaveRuntime(
                ai.fireweave.sdk.FireweaveConfig.builder().build(),
                new FireweaveLocalAdapter(Map.of("fw-on", true)));
        runtime.initialize();
        var miss = runtime.evaluate("missing", FlagType.BOOLEAN, JsonValue.of(false),
                null, EvaluationContext.builder().targetingKey("u").build(), null);
        assertEquals(Reasons.ERROR, miss.reason());
        assertEquals("FlagNotFound", miss.error().kind().name());
        runtime.shutdown();
    }
}
