package ai.fireweave.testing;

import ai.fireweave.sdk.JsonValue;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Jackson ↔ canonical {@link JsonValue} bridging for fixtures and reports. */
public final class Json {

    private Json() {
    }

    public static JsonValue fromJackson(JsonNode node) {
        if (node == null || node.isNull() || node.isMissingNode()) {
            return JsonValue.ofNull();
        }
        if (node.isBoolean()) {
            return JsonValue.of(node.booleanValue());
        }
        if (node.isIntegralNumber()) {
            return JsonValue.of(node.longValue());
        }
        if (node.isNumber()) {
            return JsonValue.of(node.doubleValue());
        }
        if (node.isTextual()) {
            return JsonValue.of(node.textValue());
        }
        if (node.isArray()) {
            List<JsonValue> items = new ArrayList<>(node.size());
            for (JsonNode child : node) {
                items.add(fromJackson(child));
            }
            return JsonValue.ofArray(items);
        }
        if (node.isObject()) {
            Map<String, JsonValue> fields = new LinkedHashMap<>();
            Iterator<Map.Entry<String, JsonNode>> it = node.fields();
            while (it.hasNext()) {
                Map.Entry<String, JsonNode> e = it.next();
                fields.put(e.getKey(), fromJackson(e.getValue()));
            }
            return JsonValue.ofObject(fields);
        }
        return JsonValue.of(node.asText());
    }

    public static JsonNode toJackson(JsonValue v) {
        JsonNodeFactory f = JsonNodeFactory.instance;
        switch (v.kind()) {
            case NULL:
                return f.nullNode();
            case BOOLEAN:
                return f.booleanNode(v.asBoolean());
            case NUMBER: {
                Number n = v.asNumber();
                if (v.isIntegralNumber() && !(n instanceof Double || n instanceof Float)) {
                    return f.numberNode(n.longValue());
                }
                if (v.isIntegralNumber()) {
                    double d = n.doubleValue();
                    if (Math.abs(d) < 9.007199254740992E15) {
                        return f.numberNode((long) d);
                    }
                }
                return f.numberNode(n.doubleValue());
            }
            case STRING:
                return f.textNode(v.asString());
            case ARRAY: {
                ArrayNode arr = f.arrayNode();
                for (JsonValue item : v.asArray()) {
                    arr.add(toJackson(item));
                }
                return arr;
            }
            case OBJECT: {
                ObjectNode obj = f.objectNode();
                for (Map.Entry<String, JsonValue> e : v.asObject().entrySet()) {
                    obj.set(e.getKey(), toJackson(e.getValue()));
                }
                return obj;
            }
            default:
                throw new IllegalStateException("unreachable");
        }
    }
}
