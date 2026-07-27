package ai.fireweave.openfeature;

import ai.fireweave.sdk.EvaluationContext;
import ai.fireweave.sdk.JsonValue;
import dev.openfeature.sdk.Value;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Maps OpenFeature {@link dev.openfeature.sdk.EvaluationContext} to the canonical Fireweave
 * {@link EvaluationContext}. {@code targetingKey} maps to the backend identity (PostHog
 * {@code distinct_id}); the "targetingKey" attribute slot is never copied as a plain attribute
 * (the Java OF SDK stores the targeting key in the attribute map).
 */
final class ContextMapper {

    private ContextMapper() {
    }

    static EvaluationContext fromOpenFeature(dev.openfeature.sdk.EvaluationContext ofCtx) {
        if (ofCtx == null) {
            return EvaluationContext.empty();
        }
        EvaluationContext.Builder b = EvaluationContext.builder();
        String targetingKey = ofCtx.getTargetingKey();
        if (targetingKey != null && !targetingKey.isEmpty()) {
            b.targetingKey(targetingKey);
        }
        for (Map.Entry<String, Value> e : ofCtx.asMap().entrySet()) {
            if ("targetingKey".equals(e.getKey())) {
                continue;
            }
            b.attribute(e.getKey(), toJsonValue(e.getValue()));
        }
        return b.build();
    }

    static JsonValue toJsonValue(Value v) {
        if (v == null || v.isNull()) {
            return JsonValue.ofNull();
        }
        if (v.isBoolean()) {
            return JsonValue.of(v.asBoolean());
        }
        if (v.isString()) {
            return JsonValue.of(v.asString());
        }
        if (v.isNumber()) {
            Double d = v.asDouble();
            if (d != null && d == Math.rint(d) && Math.abs(d) <= ai.fireweave.sdk.Capabilities.INT_SAFE_MAX_ABS) {
                Integer i = v.asInteger();
                if (i != null && i.doubleValue() == d) {
                    return JsonValue.of(i);
                }
                return JsonValue.of(d.longValue());
            }
            return JsonValue.of(d);
        }
        if (v.isList()) {
            List<Value> list = v.asList();
            java.util.ArrayList<JsonValue> items = new java.util.ArrayList<>(list.size());
            for (Value item : list) {
                items.add(toJsonValue(item));
            }
            return JsonValue.ofArray(items);
        }
        if (v.isStructure()) {
            Map<String, JsonValue> fields = new LinkedHashMap<>();
            for (Map.Entry<String, Value> e : v.asStructure().asMap().entrySet()) {
                fields.put(e.getKey(), toJsonValue(e.getValue()));
            }
            return JsonValue.ofObject(fields);
        }
        // Instant and other exotic Value types: canonicalize as string.
        return JsonValue.of(String.valueOf(v.asObject()));
    }

    static Value toOpenFeatureValue(JsonValue v) {
        switch (v.kind()) {
            case NULL:
                return new Value();
            case BOOLEAN:
                return new Value(v.asBoolean());
            case NUMBER: {
                Number n = v.asNumber();
                if (v.isIntegralNumber() && Math.abs(n.longValue()) <= Integer.MAX_VALUE
                        && !(n instanceof Double || n instanceof Float)) {
                    return new Value(n.intValue());
                }
                return new Value(n.doubleValue());
            }
            case STRING:
                return new Value(v.asString());
            case ARRAY: {
                java.util.List<Value> items = new java.util.ArrayList<>();
                for (JsonValue item : v.asArray()) {
                    items.add(toOpenFeatureValue(item));
                }
                return new Value(items);
            }
            case OBJECT: {
                Map<String, Value> fields = new LinkedHashMap<>();
                for (Map.Entry<String, JsonValue> e : v.asObject().entrySet()) {
                    fields.put(e.getKey(), toOpenFeatureValue(e.getValue()));
                }
                return new Value(new dev.openfeature.sdk.ImmutableStructure(fields));
            }
            default:
                throw new IllegalStateException("unreachable");
        }
    }
}
