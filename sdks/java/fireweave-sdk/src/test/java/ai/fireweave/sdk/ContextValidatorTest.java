package ai.fireweave.sdk;

import org.junit.jupiter.api.Test;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/** Ratified bounds: 128 attrs / 256B key / 4KiB value / depth 6 / 64KiB serialized. */
class ContextValidatorTest {

    private static final ContextLimits LIMITS = ContextLimits.canonical();

    private static void expectInvalid(EvaluationContext ctx, String messagePart) {
        FireweaveException e = assertThrows(FireweaveException.class,
                () -> ContextValidator.validate(ctx, false, LIMITS, Collections.emptySet()));
        assertEquals(ErrorKind.InvalidContext, e.kind());
        org.junit.jupiter.api.Assertions.assertTrue(e.getMessage().contains(messagePart),
                e.getMessage());
    }

    @Test
    void targetingKeyRequired() {
        FireweaveException e = assertThrows(FireweaveException.class, () ->
                ContextValidator.validate(EvaluationContext.empty(), true, LIMITS, Collections.emptySet()));
        assertEquals("TARGETING_KEY_MISSING", e.openFeatureErrorCode());
        assertEquals(ErrorKind.InvalidContext, e.kind());
    }

    @Test
    void attributeCountBound() {
        EvaluationContext.Builder b = EvaluationContext.builder().targetingKey("k");
        for (int i = 0; i < 129; i++) {
            b.attribute("a" + i, i);
        }
        expectInvalid(b.build(), "attribute count");
    }

    @Test
    void keySizeBound() {
        StringBuilder key = new StringBuilder();
        for (int i = 0; i < 257; i++) {
            key.append('K');
        }
        expectInvalid(EvaluationContext.builder().targetingKey("k")
                .attribute(key.toString(), "x").build(), "key exceeds");
    }

    @Test
    void valueSizeBound() {
        char[] big = new char[4097];
        java.util.Arrays.fill(big, 'B');
        expectInvalid(EvaluationContext.builder().targetingKey("k")
                .attribute("blob", new String(big)).build(), "value exceeds");
    }

    @Test
    void nestingDepthBound() {
        // d1..d8 nested objects with a scalar at d9: containers depth 8 + attributes object = 9 > 6.
        JsonValue leaf = JsonValue.of("x");
        JsonValue node = leaf;
        for (int i = 0; i < 8; i++) {
            Map<String, JsonValue> m = new LinkedHashMap<>();
            m.put("d", node);
            node = JsonValue.ofObject(m);
        }
        expectInvalid(EvaluationContext.builder().targetingKey("k")
                .attribute("d1", node).build(), "nesting depth");
    }

    @Test
    void depthWithinBoundAccepted() {
        Map<String, JsonValue> inner = new LinkedHashMap<>();
        inner.put("ok", JsonValue.of(true));
        Map<String, JsonValue> outer = new LinkedHashMap<>();
        outer.put("child", JsonValue.ofObject(inner));
        EvaluationContext ctx = EvaluationContext.builder().targetingKey("k")
                .attribute("meta", JsonValue.ofObject(outer))
                .attribute("labels", JsonValue.ofArray(java.util.Arrays.asList(
                        JsonValue.of("a"), JsonValue.of("b"))))
                .attribute("optional", JsonValue.ofNull())
                .build();
        assertDoesNotThrow(() ->
                ContextValidator.validate(ctx, true, LIMITS, Collections.emptySet()));
    }

    @Test
    void serializedSizeBound() {
        EvaluationContext.Builder b = EvaluationContext.builder().targetingKey("k");
        char[] chunk = new char[4000];
        java.util.Arrays.fill(chunk, 'X');
        for (int i = 0; i < 20; i++) {
            b.attribute("p" + i, new String(chunk));
        }
        expectInvalid(b.build(), "serialized context");
    }

    @Test
    void reservedPrefixAndConfiguredKeysRejected() {
        expectInvalid(EvaluationContext.builder().targetingKey("k")
                .attribute("fireweave.internal", "x").build(), "invalid evaluation context");

        FireweaveException e = assertThrows(FireweaveException.class, () ->
                ContextValidator.validate(
                        EvaluationContext.builder().targetingKey("k")
                                .attribute("targetingKey", "dup").build(),
                        false, LIMITS, Set.of("targetingKey", "kind")));
        assertEquals(ErrorKind.InvalidContext, e.kind());
    }
}
