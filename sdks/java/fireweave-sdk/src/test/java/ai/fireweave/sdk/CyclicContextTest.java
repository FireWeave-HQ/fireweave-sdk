package ai.fireweave.sdk;

import ai.fireweave.sdk.domain.ContextLimits;
import ai.fireweave.sdk.domain.ErrorKind;
import ai.fireweave.sdk.domain.EvaluationContext;
import ai.fireweave.sdk.domain.JsonValue;
import ai.fireweave.sdk.domain.Validation;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Ordinary {@code java.util.Map}/{@code java.util.List} CAN be self-referential
 * ({@code Map<String,Object> m = new HashMap<>(); m.put("self", m);}) — unlike this SDK's
 * immutable, copy-on-construct {@link JsonValue} tree, which cannot represent a cycle at all
 * through its own builder (every {@code JsonValue} instance must already exist before it can be
 * nested inside a parent, so there is no way to make one contain itself). {@link
 * EvaluationContext.Builder#attribute(String, Object)} is the one reachable place a genuinely
 * cyclic evaluation-context input can enter the Java SDK.
 *
 * <p>Two distinct claims, not to be confused: (1) CONSTRUCTION must never crash on one — a naive
 * recursive walk would blow the stack, exactly the kind of crash a "before any I/O" pipeline must
 * not allow (spec/control-points.md "Return discipline"); (2) a cyclic context is NOT a valid one
 * — it fails CLOSED as InvalidContext through {@link Validation#validateContext}, matching
 * node's {@code validateContext} (WeakSet-based cycle detection) and python's ratified fix (Task
 * 7 review round: cyclic contexts were previously failing OPEN there). "Doesn't crash" and "is
 * accepted" are different claims; only the first is true of a cyclic context here.
 */
class CyclicContextTest {

    private static final ContextLimits LIMITS = ContextLimits.canonical();

    private static Validation.Validated<EvaluationContext> validate(EvaluationContext ctx) {
        return Validation.validateContext(ctx, false, LIMITS, Collections.emptySet());
    }

    @Test
    void selfReferentialMapDoesNotCrashConstruction() {
        Map<String, Object> cyclic = new HashMap<>();
        cyclic.put("self", cyclic);
        EvaluationContext ctx = EvaluationContext.builder().targetingKey("u")
                .attribute("plan", "pro")
                .attribute("loop", cyclic)
                .build();
        // The cyclic branch is replaced with null instead of being recursed into forever;
        // sibling data survives untouched.
        assertEquals(JsonValue.of("pro"), ctx.attributes().get("plan"));
        assertEquals(JsonValue.ofNull(), ctx.attributes().get("loop").asObject().get("self"));
        // And the break is recorded — this is what lets validateContext fail closed later
        // without re-walking the (already-safe) data.
        assertTrue(ctx.hadCyclicInput());
    }

    @Test
    void selfReferentialListDoesNotCrashConstruction() {
        List<Object> cyclic = new ArrayList<>();
        cyclic.add(cyclic);
        EvaluationContext ctx = EvaluationContext.builder().targetingKey("u")
                .attribute("loop", cyclic)
                .build();
        assertEquals(JsonValue.ofNull(), ctx.attributes().get("loop").asArray().get(0));
        assertTrue(ctx.hadCyclicInput());
    }

    @Test
    void sharedNonCyclicReferenceIsNotTreatedAsACycle() {
        Map<String, Object> shared = new HashMap<>();
        shared.put("x", 1);
        EvaluationContext ctx = EvaluationContext.builder().targetingKey("u")
                .attribute("a", shared)
                .attribute("b", shared)
                .build();
        assertEquals(JsonValue.of(1), ctx.attributes().get("a").asObject().get("x"));
        assertEquals(JsonValue.of(1), ctx.attributes().get("b").asObject().get("x"));
        // No false positive: two siblings referencing the same object is legal sharing, not a
        // cycle — the identity-based seen-set backtracks (removes the id) after each subtree
        // completes, so a shared reference visited a second time (not on the active recursion
        // path) is copied correctly rather than flagged.
        assertFalse(ctx.hadCyclicInput());
        assertTrue(validate(ctx).isOk());
    }

    @Test
    void cyclicContextFailsClosedViaValidateContext() {
        Map<String, Object> cyclic = new HashMap<>();
        cyclic.put("self", cyclic);
        EvaluationContext ctx = EvaluationContext.builder().targetingKey("u")
                .attribute("loop", cyclic).build();
        Validation.Validated<EvaluationContext> result = validate(ctx);
        assertFalse(result.isOk());
        assertEquals(ErrorKind.InvalidContext, result.error().kind());
        assertTrue(result.error().getMessage().contains("circular reference"));
    }

    /**
     * The actual runtime pipeline (FireweaveRuntime.evaluate) always merges global/client/
     * invocation layers before validating — a cyclic layer's OWN copy already broke its cycle to
     * null by the time merge() sees it, so the flag (not the data) is what survives the merge.
     * This pins that propagation.
     */
    @Test
    void cyclicContextFailsClosedThroughMerge() {
        Map<String, Object> cyclic = new HashMap<>();
        cyclic.put("self", cyclic);
        EvaluationContext invocation = EvaluationContext.builder().targetingKey("u")
                .attribute("loop", cyclic).build();
        EvaluationContext merged = EvaluationContext.builder().targetingKey("u")
                .attribute("tier", "gold").build()
                .merge(EvaluationContext.empty())
                .merge(invocation);
        assertTrue(merged.hadCyclicInput());
        Validation.Validated<EvaluationContext> result = validate(merged);
        assertFalse(result.isOk());
        assertEquals(ErrorKind.InvalidContext, result.error().kind());
        assertTrue(result.error().getMessage().contains("circular reference"));
    }

    /**
     * A cyclic context that ALSO breaches another bound (a reserved key) still reports the
     * circular-reference message — cycle detection is the first check, matching node's
     * validateContext ordering.
     */
    @Test
    void cycleCheckRunsBeforeAnyOtherContextRule() {
        Map<String, Object> cyclic = new HashMap<>();
        cyclic.put("self", cyclic);
        EvaluationContext ctx = EvaluationContext.builder().targetingKey("u")
                .attribute("loop", cyclic)
                .attribute("fireweave.notAllowed", "x")
                .build();
        Validation.Validated<EvaluationContext> result = validate(ctx);
        assertFalse(result.isOk());
        assertTrue(result.error().getMessage().contains("circular reference"));
    }

    @Test
    void unsupportedRawAttributeValueTypeThrowsImmediatelyAtConstruction() {
        // A genuine caller bug (not a data-driven failure, unlike the cycle case above): thrown
        // synchronously at build() time, not deferred to validation.
        org.junit.jupiter.api.Assertions.assertThrows(IllegalArgumentException.class, () ->
                EvaluationContext.builder().attribute("bad", new Object()));
    }
}
