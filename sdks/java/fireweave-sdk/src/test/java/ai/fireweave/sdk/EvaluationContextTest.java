package ai.fireweave.sdk;

import ai.fireweave.sdk.domain.EvaluationContext;
import ai.fireweave.sdk.domain.JsonValue;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class EvaluationContextTest {

    @Test
    void mergeLaterWinsGlobalClientInvocation() {
        EvaluationContext global = EvaluationContext.builder()
                .targetingKey("org_1").attribute("tier", "bronze").attribute("region", "us").build();
        EvaluationContext client = EvaluationContext.builder().attribute("tier", "silver").build();
        EvaluationContext invocation = EvaluationContext.builder().attribute("tier", "gold").build();

        EvaluationContext merged = global.merge(client).merge(invocation);
        assertEquals("org_1", merged.targetingKey());
        assertEquals(JsonValue.of("gold"), merged.attributes().get("tier"));
        assertEquals(JsonValue.of("us"), merged.attributes().get("region"));
    }

    @Test
    void mergeDoesNotMutateInputs() {
        EvaluationContext a = EvaluationContext.builder().targetingKey("a").attribute("x", 1).build();
        EvaluationContext b = EvaluationContext.builder().attribute("x", 2).build();
        a.merge(b);
        assertEquals(JsonValue.of(1), a.attributes().get("x"));
        assertEquals(JsonValue.of(2), b.attributes().get("x"));
    }

    @Test
    void attributesViewIsImmutable() {
        EvaluationContext ctx = EvaluationContext.builder().attribute("plan", "pro").build();
        assertThrows(UnsupportedOperationException.class,
                () -> ctx.attributes().put("plan", JsonValue.of("free")));
        assertThrows(UnsupportedOperationException.class,
                () -> ctx.groups().put("org", "x"));
    }

    @Test
    void groupsAndGroupPropertiesMergeByKey() {
        EvaluationContext a = EvaluationContext.builder()
                .group("organization", "org_1")
                .groupProperty("organization", "plan", JsonValue.of("free")).build();
        EvaluationContext b = EvaluationContext.builder()
                .groupProperty("organization", "plan", JsonValue.of("enterprise")).build();
        EvaluationContext merged = a.merge(b);
        assertEquals("org_1", merged.groups().get("organization"));
        assertEquals(JsonValue.of("enterprise"),
                merged.groupProperties().get("organization").get("plan"));
    }
}
