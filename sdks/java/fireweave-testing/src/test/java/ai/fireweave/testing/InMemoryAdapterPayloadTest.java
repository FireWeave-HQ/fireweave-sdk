package ai.fireweave.testing;

import ai.fireweave.sdk.application.EvaluationOptions;
import ai.fireweave.sdk.application.EvaluationRequest;
import ai.fireweave.sdk.domain.Decision;
import ai.fireweave.sdk.domain.EvaluationContext;
import ai.fireweave.sdk.domain.FireweaveException;
import ai.fireweave.sdk.domain.FlagType;
import ai.fireweave.sdk.domain.JsonValue;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Regression coverage for task-10b item 5
 * (contracts/evaluation/eval-payload-attached.json): {@link InMemoryAdapter} previously had no
 * {@code payload} field on {@link InMemoryAdapter.FlagDefinition} at all, and
 * {@link EvaluationOptions} was an inert marker with no {@code includePayload} equivalent, so
 * {@code fireweave.payload} was never attached to flagMetadata.
 */
class InMemoryAdapterPayloadTest {

    private static InMemoryAdapter.FlagDefinition booleanFlag(JsonValue payload) {
        InMemoryAdapter.FlagDefinition def = new InMemoryAdapter.FlagDefinition();
        def.type = FlagType.BOOLEAN;
        def.enabled = true;
        def.variant = "on";
        def.value = JsonValue.of(true);
        def.payload = payload;
        return def;
    }

    private static Decision evaluate(InMemoryAdapter adapter, EvaluationOptions options) throws FireweaveException {
        EvaluationRequest request = new EvaluationRequest(
                "f", FlagType.BOOLEAN, JsonValue.of(false), EvaluationContext.builder().targetingKey("u").build(),
                options);
        return adapter.evaluate(request);
    }

    @Test
    void includePayloadAttachesSortedKeyJson() throws Exception {
        Map<String, JsonValue> payload = new LinkedHashMap<>();
        payload.put("b", JsonValue.of(1));
        payload.put("a", JsonValue.of(2));
        InMemoryAdapter adapter = new InMemoryAdapter(Map.of("f", booleanFlag(JsonValue.ofObject(payload))));

        Decision d = evaluate(adapter, EvaluationOptions.withIncludePayload(true));
        assertEquals("{\"a\":2,\"b\":1}", d.flagMetadata().get("fireweave.payload"));
    }

    @Test
    void payloadOmittedWhenIncludePayloadFalse() throws Exception {
        InMemoryAdapter adapter = new InMemoryAdapter(
                Map.of("f", booleanFlag(JsonValue.ofObject(Map.of("a", JsonValue.of(1))))));

        Decision d = evaluate(adapter, EvaluationOptions.defaults());
        assertFalse(d.flagMetadata().containsKey("fireweave.payload"));
    }

    @Test
    void payloadOmittedWhenOptionsNull() throws Exception {
        InMemoryAdapter adapter = new InMemoryAdapter(
                Map.of("f", booleanFlag(JsonValue.ofObject(Map.of("a", JsonValue.of(1))))));

        Decision d = evaluate(adapter, null);
        assertFalse(d.flagMetadata().containsKey("fireweave.payload"));
    }

    @Test
    void payloadOmittedWhenFlagHasNoneEvenIfRequested() throws Exception {
        InMemoryAdapter adapter = new InMemoryAdapter(Map.of("f", booleanFlag(null)));

        Decision d = evaluate(adapter, EvaluationOptions.withIncludePayload(true));
        assertFalse(d.flagMetadata().containsKey("fireweave.payload"));
    }

    @Test
    void withIncludePayloadFalseSharesIdentityWithDefaults() {
        assertTrue(EvaluationOptions.withIncludePayload(false) == EvaluationOptions.defaults());
    }

    /**
     * task-10b review-round finding: a payload that already arrives as a raw JSON string
     * (spec/remote-evaluate.schema.json's payload field is unconstrained {@code jsonValue};
     * node's ports.ts documents this shape explicitly: "object or pre-serialized JSON string")
     * must be exposed VERBATIM. {@code def.payload.toCanonicalJson()} would double-encode a
     * string-kind value (wrapping it in an extra pair of quotes with escaped internals) —
     * {@link JsonValue#toPayloadString()} is the shared fix, mirroring node's and python's
     * identical ternary.
     */
    @Test
    void stringPayloadPassesThroughVerbatim() throws Exception {
        String raw = "{\"already\":\"serialized\",\"b\":1}";
        InMemoryAdapter adapter = new InMemoryAdapter(Map.of("f", booleanFlag(JsonValue.of(raw))));

        Decision d = evaluate(adapter, EvaluationOptions.withIncludePayload(true));
        assertEquals(raw, d.flagMetadata().get("fireweave.payload"));
    }
}
