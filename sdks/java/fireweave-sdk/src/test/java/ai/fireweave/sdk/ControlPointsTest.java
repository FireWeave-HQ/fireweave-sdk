package ai.fireweave.sdk;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.Map;
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
    void clientLevelHelpersDelegate() {
        EvaluationContext ctx = EvaluationContext.builder().targetingKey("user_42").build();
        assertTrue(client.getBooleanValue("new-checkout", false, ctx));
        Decision d = client.evaluate("new-checkout", FlagType.BOOLEAN, JsonValue.of(false), ctx, null);
        assertEquals(Reasons.STATIC, d.reason());
        assertEquals("on", d.variant());
    }

    @Test
    void typedHelpersReturnDefaultsForMissingKeys() {
        EvaluationContext ctx = EvaluationContext.builder().targetingKey("user_42").build();
        assertEquals("fallback", client.controlPoints().getStringValue("missing", "fallback", ctx));
        assertEquals(7, client.controlPoints().getIntegerValue("missing", 7, ctx));
        assertEquals(0.5, client.controlPoints().getDoubleValue("missing", 0.5, ctx));
        JsonValue obj = JsonValue.ofObject(java.util.Collections.singletonMap("a", JsonValue.of(1)));
        assertEquals(obj, client.controlPoints().getObjectValue("missing", obj, ctx));
    }

    @Test
    void capabilitiesAdvertiseControlPointsAndRemoteAdapter() {
        Map<String, Boolean> features = client.capabilities().get().staticFeatures();
        assertEquals(Boolean.TRUE, features.get("controlPoints"));
        assertEquals(Boolean.TRUE, features.get("flags"));
        assertEquals(Boolean.TRUE, features.get("remoteAdapter"));
    }

    @Test
    void flagsAliasSilentByDefault() {
        String previous = System.getenv("FW_DEPRECATION_WARNINGS");
        // Cannot unset env portably; assert no extra requirement when unset/not "1".
        if ("1".equals(previous)) {
            return;
        }
        TestHandler handler = new TestHandler();
        Logger log = Logger.getLogger(FireweaveClient.class.getName());
        log.addHandler(handler);
        try {
            client.flags();
            assertEquals(0, handler.warnings);
        } finally {
            log.removeHandler(handler);
        }
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
