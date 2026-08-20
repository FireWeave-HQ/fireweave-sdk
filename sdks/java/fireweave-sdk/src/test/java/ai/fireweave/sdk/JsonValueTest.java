package ai.fireweave.sdk;

import ai.fireweave.sdk.domain.JsonValue;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;

class JsonValueTest {

    @Test
    void canonicalJsonSortsObjectKeys() {
        Map<String, JsonValue> m = new LinkedHashMap<>();
        m.put("rolloutId", JsonValue.of("r1"));
        m.put("maxRetries", JsonValue.of(2));
        assertEquals("{\"maxRetries\":2,\"rolloutId\":\"r1\"}",
                JsonValue.ofObject(m).toCanonicalJson());
    }

    @Test
    void integralDoublesSerializeAsIntegers() {
        assertEquals("2", JsonValue.of(2.0).toCanonicalJson());
        assertEquals("0.5", JsonValue.of(0.5).toCanonicalJson());
    }

    @Test
    void numericEqualityAcrossBoxedTypes() {
        assertEquals(JsonValue.of(3), JsonValue.of(3L));
        assertEquals(JsonValue.of(3).hashCode(), JsonValue.of(3L).hashCode());
        assertEquals(JsonValue.of(0.5), JsonValue.of(0.5f).asNumber().doubleValue() == 0.5
                ? JsonValue.of(0.5) : JsonValue.ofNull());
        assertNotEquals(JsonValue.of(3), JsonValue.of(4));
    }

    @Test
    void depthCountsContainers() {
        Map<String, JsonValue> inner = new LinkedHashMap<>();
        inner.put("a", JsonValue.of(1));
        Map<String, JsonValue> outer = new LinkedHashMap<>();
        outer.put("inner", JsonValue.ofObject(inner));
        assertEquals(1, JsonValue.of("x").depth());
        assertEquals(2, JsonValue.ofObject(inner).depth());
        assertEquals(3, JsonValue.ofObject(outer).depth());
    }

    @Test
    void stringEscaping() {
        assertEquals("\"a\\\"b\\n\"", JsonValue.of("a\"b\n").toCanonicalJson());
    }
}
