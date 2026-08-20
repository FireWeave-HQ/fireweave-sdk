package ai.fireweave.sdk;

import ai.fireweave.sdk.application.FireweaveClient;
import ai.fireweave.sdk.application.FireweaveConfig;
import ai.fireweave.sdk.application.FireweaveRuntime;
import ai.fireweave.sdk.domain.Decision;
import ai.fireweave.sdk.domain.EvaluationContext;
import ai.fireweave.sdk.domain.JsonValue;
import ai.fireweave.sdk.infrastructure.adapters.FireweaveLocalAdapter;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Field;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.logging.Handler;
import java.util.logging.Level;
import java.util.logging.LogRecord;
import java.util.logging.Logger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

final class ControlPointsTest {

    private FireweaveRuntime runtime;
    private FireweaveClient client;

    @BeforeEach
    void setUp() throws Exception {
        Map<String, Boolean> flags = new LinkedHashMap<>();
        flags.put("new-checkout", true);
        flags.put("legacy-off", false);
        runtime = new FireweaveRuntime(FireweaveConfig.builder().build(),
                new FireweaveLocalAdapter(flags));
        runtime.initialize();
        client = new FireweaveClient(runtime);
    }

    @AfterEach
    void tearDown() {
        runtime.shutdown();
    }

    @Test
    void controlPointsGetBooleanValue() {
        EvaluationContext ctx = EvaluationContext.builder().targetingKey("user_42").build();
        assertTrue(client.controlPoints().getBooleanValue("new-checkout", false, ctx));
        assertEquals(false, client.controlPoints().getBooleanValue("legacy-off", true, ctx));
    }

    @Test
    void flagsIsTheSameObjectAsControlPoints() {
        assertSame(client.controlPoints(), client.flags());
        EvaluationContext ctx = EvaluationContext.builder().targetingKey("user_42").build();
        assertTrue(client.flags().getBooleanValue("new-checkout", false, ctx));
    }

    @Test
    void typedHelpersReturnDefaultsForMissingKeys() {
        EvaluationContext ctx = EvaluationContext.builder().targetingKey("user_42").build();
        assertEquals("fallback", client.controlPoints().getStringValue("missing", "fallback", ctx));
        assertEquals(0.5, client.controlPoints().getNumberValue("missing", 0.5, ctx));
        JsonValue obj = JsonValue.ofObject(java.util.Collections.singletonMap("a", JsonValue.of(1)));
        assertEquals(obj, client.controlPoints().getObjectValue("missing", obj, ctx));
    }

    @Test
    void detailsReturnsTheWholeDecisionValueReturnsTheBareValue() {
        EvaluationContext ctx = EvaluationContext.builder().targetingKey("user_42").build();
        boolean value = client.controlPoints().getBooleanValue("new-checkout", false, ctx);
        Decision details = client.controlPoints().getBooleanDetails("new-checkout", false, ctx);

        assertEquals(true, value);
        assertEquals(true, details.value().asBoolean());
        assertEquals("new-checkout", details.flagKey());
        assertTrue(details.reason() != null && !details.reason().isEmpty());
    }

    @Test
    void allFourDetailsMethodsDelegateToEvaluate() {
        EvaluationContext ctx = EvaluationContext.builder().targetingKey("user_42").build();
        // The local adapter's unknown-key row is default/DEFAULT, not an error (spec/modes.md
        // "Behaviour per mode") — exercised here across all four *Details methods to prove each
        // one truly delegates to the shared evaluate() pipeline rather than a parallel path.
        assertEquals("STATIC", client.controlPoints().getBooleanDetails("new-checkout", false, ctx).reason());
        assertEquals("DEFAULT", client.controlPoints().getStringDetails("missing", "x", ctx).reason());
        assertEquals("DEFAULT", client.controlPoints().getNumberDetails("missing", 1.0, ctx).reason());
        JsonValue obj = JsonValue.ofObject(java.util.Collections.emptyMap());
        assertEquals("DEFAULT", client.controlPoints().getObjectDetails("missing", obj, ctx).reason());

        // A genuine ERROR path: "new-checkout" is a devFlags boolean, so reading it as a string
        // is a TypeMismatch — proving the ERROR reason is still reachable through *Details.
        assertEquals("ERROR", client.controlPoints().getStringDetails("new-checkout", "x", ctx).reason());
    }

    @Test
    void flagsAliasWarnsOncePerProcessUnconditionally() throws Exception {
        // Unconditional (no env gate): the SDK reads no environment variables
        // (spec/modes.md "The SDK reads no environment variables", unscoped).
        resetFlagsDeprecationNotice();
        TestHandler handler = new TestHandler();
        Logger log = Logger.getLogger(FireweaveClient.class.getName());
        log.addHandler(handler);
        try {
            client.flags();
            client.flags();
            assertEquals(1, handler.warnings, "warns exactly once across two calls");
        } finally {
            log.removeHandler(handler);
        }
    }

    private static void resetFlagsDeprecationNotice() throws Exception {
        Field f = FireweaveClient.class.getDeclaredField("FLAGS_DEPRECATION_NOTICED");
        f.setAccessible(true);
        ((AtomicBoolean) f.get(null)).set(false);
    }

    private static final class TestHandler extends Handler {
        int warnings;

        @Override
        public void publish(LogRecord record) {
            if (record.getLevel() == Level.WARNING) {
                warnings++;
            }
        }

        @Override
        public void flush() {
        }

        @Override
        public void close() {
        }
    }
}
