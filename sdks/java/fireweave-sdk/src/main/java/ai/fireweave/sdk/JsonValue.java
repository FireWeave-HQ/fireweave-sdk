package ai.fireweave.sdk;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.TreeMap;

/**
 * Immutable JSON-compatible value (null / boolean / number / string / array / object) used for
 * context attributes, flag values, and payloads. This is the Fireweave-owned replacement for
 * vendor value types: no PostHog or OpenFeature types appear in the core public API.
 *
 * <p>Thread-safety: instances are deeply immutable and safe to share across threads.
 *
 * <p>Numbers: stored as {@link Number}. Equality treats integral values as equal regardless of
 * boxed type (2 == 2L == 2.0). Cross-language integer flags are reliable within +/-(2^53-1);
 * see the Java limitations note in {@code sdks/java/README.md}.
 */
public final class JsonValue {

    public enum Kind { NULL, BOOLEAN, NUMBER, STRING, ARRAY, OBJECT }

    private static final JsonValue NULL_VALUE = new JsonValue(Kind.NULL, null);
    private static final JsonValue TRUE = new JsonValue(Kind.BOOLEAN, Boolean.TRUE);
    private static final JsonValue FALSE = new JsonValue(Kind.BOOLEAN, Boolean.FALSE);

    private final Kind kind;
    private final Object value;

    private JsonValue(Kind kind, Object value) {
        this.kind = kind;
        this.value = value;
    }

    public static JsonValue ofNull() {
        return NULL_VALUE;
    }

    public static JsonValue of(boolean b) {
        return b ? TRUE : FALSE;
    }

    public static JsonValue of(Number n) {
        Objects.requireNonNull(n, "number");
        return new JsonValue(Kind.NUMBER, n);
    }

    public static JsonValue of(String s) {
        Objects.requireNonNull(s, "string");
        return new JsonValue(Kind.STRING, s);
    }

    public static JsonValue ofArray(List<JsonValue> items) {
        Objects.requireNonNull(items, "items");
        return new JsonValue(Kind.ARRAY, Collections.unmodifiableList(new ArrayList<>(items)));
    }

    public static JsonValue ofObject(Map<String, JsonValue> fields) {
        Objects.requireNonNull(fields, "fields");
        return new JsonValue(Kind.OBJECT, Collections.unmodifiableMap(new LinkedHashMap<>(fields)));
    }

    public Kind kind() {
        return kind;
    }

    public boolean isNull() {
        return kind == Kind.NULL;
    }

    public boolean asBoolean() {
        require(Kind.BOOLEAN);
        return (Boolean) value;
    }

    public Number asNumber() {
        require(Kind.NUMBER);
        return (Number) value;
    }

    public String asString() {
        require(Kind.STRING);
        return (String) value;
    }

    @SuppressWarnings("unchecked")
    public List<JsonValue> asArray() {
        require(Kind.ARRAY);
        return (List<JsonValue>) value;
    }

    @SuppressWarnings("unchecked")
    public Map<String, JsonValue> asObject() {
        require(Kind.OBJECT);
        return (Map<String, JsonValue>) value;
    }

    private void require(Kind expected) {
        if (kind != expected) {
            throw new IllegalStateException("JsonValue is " + kind + ", not " + expected);
        }
    }

    /** True when this is a NUMBER with no fractional part. */
    public boolean isIntegralNumber() {
        if (kind != Kind.NUMBER) {
            return false;
        }
        Number n = (Number) value;
        if (n instanceof Double || n instanceof Float) {
            double d = n.doubleValue();
            return !Double.isNaN(d) && !Double.isInfinite(d) && d == Math.rint(d);
        }
        return true;
    }

    /** Maximum nesting depth of this value: scalars are 1, containers are 1 + max(child). */
    public int depth() {
        switch (kind) {
            case ARRAY: {
                int max = 0;
                for (JsonValue v : asArray()) {
                    max = Math.max(max, v.depth());
                }
                return 1 + max;
            }
            case OBJECT: {
                int max = 0;
                for (JsonValue v : asObject().values()) {
                    max = Math.max(max, v.depth());
                }
                return 1 + max;
            }
            default:
                return 1;
        }
    }

    /** Canonical JSON: sorted object keys, no whitespace, minimal number formatting. */
    public String toCanonicalJson() {
        StringBuilder sb = new StringBuilder();
        writeCanonical(sb);
        return sb.toString();
    }

    /** UTF-8 byte size of the canonical JSON serialization. */
    public int canonicalUtf8Size() {
        return toCanonicalJson().getBytes(StandardCharsets.UTF_8).length;
    }

    private void writeCanonical(StringBuilder sb) {
        switch (kind) {
            case NULL:
                sb.append("null");
                break;
            case BOOLEAN:
                sb.append(((Boolean) value) ? "true" : "false");
                break;
            case NUMBER:
                sb.append(formatNumber((Number) value));
                break;
            case STRING:
                writeJsonString(sb, (String) value);
                break;
            case ARRAY: {
                sb.append('[');
                boolean first = true;
                for (JsonValue v : asArray()) {
                    if (!first) {
                        sb.append(',');
                    }
                    v.writeCanonical(sb);
                    first = false;
                }
                sb.append(']');
                break;
            }
            case OBJECT: {
                sb.append('{');
                Map<String, JsonValue> sorted = new TreeMap<>(asObject());
                boolean first = true;
                for (Map.Entry<String, JsonValue> e : sorted.entrySet()) {
                    if (!first) {
                        sb.append(',');
                    }
                    writeJsonString(sb, e.getKey());
                    sb.append(':');
                    e.getValue().writeCanonical(sb);
                    first = false;
                }
                sb.append('}');
                break;
            }
            default:
                throw new IllegalStateException("unreachable");
        }
    }

    static String formatNumber(Number n) {
        if (n instanceof Double || n instanceof Float) {
            double d = n.doubleValue();
            if (d == Math.rint(d) && !Double.isInfinite(d) && Math.abs(d) < 1e15) {
                return Long.toString((long) d);
            }
            return Double.toString(d);
        }
        return n.toString();
    }

    static void writeJsonString(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':
                    sb.append("\\\"");
                    break;
                case '\\':
                    sb.append("\\\\");
                    break;
                case '\n':
                    sb.append("\\n");
                    break;
                case '\r':
                    sb.append("\\r");
                    break;
                case '\t':
                    sb.append("\\t");
                    break;
                case '\b':
                    sb.append("\\b");
                    break;
                case '\f':
                    sb.append("\\f");
                    break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        sb.append('"');
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) {
            return true;
        }
        if (!(o instanceof JsonValue)) {
            return false;
        }
        JsonValue other = (JsonValue) o;
        if (kind == Kind.NUMBER && other.kind == Kind.NUMBER) {
            return numbersEqual((Number) value, (Number) other.value);
        }
        if (kind != other.kind) {
            return false;
        }
        return Objects.equals(value, other.value);
    }

    static boolean numbersEqual(Number a, Number b) {
        boolean aIntegral = !(a instanceof Double || a instanceof Float);
        boolean bIntegral = !(b instanceof Double || b instanceof Float);
        if (aIntegral && bIntegral) {
            return a.longValue() == b.longValue();
        }
        return a.doubleValue() == b.doubleValue();
    }

    @Override
    public int hashCode() {
        if (kind == Kind.NUMBER) {
            Number n = (Number) value;
            if (isIntegralNumber() && Math.abs(n.doubleValue()) < 1e15) {
                return Long.hashCode(n.longValue());
            }
            return Double.hashCode(n.doubleValue());
        }
        return Objects.hash(kind, value);
    }

    @Override
    public String toString() {
        return toCanonicalJson();
    }
}
