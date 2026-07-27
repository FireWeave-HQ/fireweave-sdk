package ai.fireweave.testing.conformance;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Normative comparator per contracts/harness.md: drop excluded keys, expected-key deep equality,
 * numeric canonicalization, extra-key detection, and *MustNotContain directives.
 */
final class FixtureComparator {

    /** EXCLUDE_SET baseline from harness.md. */
    private static final Set<String> EXCLUDE_SET = new HashSet<>(Arrays.asList(
            "timestamp", "evaluatedAt", "ts", "createdAt", "updatedAt", "stack", "stackTrace",
            "requestId", "uuid", "traceId", "spanId", "messageId", "latencyMs", "durationMs",
            "pid", "hostname"));

    /** Keys in expect that are directives, not equality assertions. */
    private static final Set<String> DIRECTIVE_KEYS = new HashSet<>(Arrays.asList(
            "errorMessageMustNotContain", "recordedMessageMustNotContain"));

    private FixtureComparator() {
    }

    static List<String> compare(JsonNode expect, ObjectNode actual) {
        List<String> problems = new ArrayList<>();
        dropExcluded(actual);
        compareObjects("", expect, actual, problems);

        JsonNode mustNotContain = expect.get("errorMessageMustNotContain");
        if (mustNotContain != null && mustNotContain.isArray()) {
            String msg = actual.hasNonNull("errorMessage") ? actual.get("errorMessage").asText() : "";
            for (JsonNode needle : mustNotContain) {
                if (msg.contains(needle.asText())) {
                    problems.add("errorMessage contains forbidden substring: " + needle.asText());
                }
            }
        }
        return problems;
    }

    private static void dropExcluded(JsonNode node) {
        if (node instanceof ObjectNode) {
            ObjectNode obj = (ObjectNode) node;
            obj.remove(EXCLUDE_SET);
            obj.fields().forEachRemaining(e -> dropExcluded(e.getValue()));
        } else if (node != null && node.isArray()) {
            node.forEach(FixtureComparator::dropExcluded);
        }
    }

    private static void compareObjects(String path, JsonNode expect, JsonNode actual, List<String> problems) {
        Iterator<Map.Entry<String, JsonNode>> it = expect.fields();
        while (it.hasNext()) {
            Map.Entry<String, JsonNode> e = it.next();
            if (path.isEmpty() && DIRECTIVE_KEYS.contains(e.getKey())) {
                continue;
            }
            String childPath = path.isEmpty() ? e.getKey() : path + "." + e.getKey();
            JsonNode actualChild = actual.get(e.getKey());
            compareNode(childPath, e.getValue(), actualChild, problems);
        }
        // Extra keys in actual (not excluded, not expected) → fail (prevents silent drift).
        Iterator<String> names = actual.fieldNames();
        while (names.hasNext()) {
            String name = names.next();
            if (!expect.has(name) && !EXCLUDE_SET.contains(name)) {
                problems.add("unexpected extra key in actual: "
                        + (path.isEmpty() ? name : path + "." + name));
            }
        }
    }

    private static void compareNode(String path, JsonNode expect, JsonNode actual, List<String> problems) {
        if (expect == null || expect.isNull()) {
            if (actual != null && !actual.isNull()) {
                problems.add(path + ": expected null, got " + actual);
            }
            return;
        }
        if (actual == null || actual.isNull()) {
            problems.add(path + ": expected " + expect + ", got null/missing");
            return;
        }
        if (expect.isObject()) {
            if (!actual.isObject()) {
                problems.add(path + ": expected object, got " + actual.getNodeType());
                return;
            }
            compareObjects(path, expect, actual, problems);
            return;
        }
        if (expect.isArray()) {
            if (!actual.isArray() || actual.size() != expect.size()) {
                problems.add(path + ": expected array " + expect + ", got " + actual);
                return;
            }
            for (int i = 0; i < expect.size(); i++) {
                compareNode(path + "[" + i + "]", expect.get(i), actual.get(i), problems);
            }
            return;
        }
        if (expect.isNumber()) {
            if (!actual.isNumber()) {
                problems.add(path + ": expected number " + expect + ", got " + actual);
                return;
            }
            boolean equal;
            if (expect.isIntegralNumber() && actual.isIntegralNumber()) {
                equal = expect.longValue() == actual.longValue();
            } else {
                equal = expect.doubleValue() == actual.doubleValue();
            }
            if (!equal) {
                problems.add(path + ": expected " + expect + ", got " + actual);
            }
            return;
        }
        if (!expect.equals(actual)) {
            problems.add(path + ": expected " + expect + ", got " + actual);
        }
    }

    /** Project actual onto the key structure of the expected shape (context echoes only). */
    static JsonNode project(JsonNode actual, JsonNode expectShape) {
        if (actual == null || !actual.isObject() || expectShape == null || !expectShape.isObject()) {
            return actual;
        }
        ObjectNode out = ((ObjectNode) actual).objectNode();
        Iterator<Map.Entry<String, JsonNode>> it = expectShape.fields();
        while (it.hasNext()) {
            Map.Entry<String, JsonNode> e = it.next();
            JsonNode child = actual.get(e.getKey());
            if (child != null) {
                out.set(e.getKey(), project(child, e.getValue()));
            }
        }
        return out;
    }
}
