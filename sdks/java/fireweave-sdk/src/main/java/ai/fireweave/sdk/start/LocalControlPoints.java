package ai.fireweave.sdk.start;

import ai.fireweave.sdk.domain.ErrorKind;
import ai.fireweave.sdk.domain.FireweaveException;
import ai.fireweave.sdk.domain.Validation;
import ai.fireweave.sdk.domain.Validation.Validated;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.TreeMap;

/**
 * Every control point the app reads, keyed by control point key, with the value served in local
 * mode. Built by {@link Fw#defineControlPoints(Map)}, which checks every key; immutable.
 *
 * <p>It conventionally lives in its own class ({@code FireweaveControlPoints.java}) and is passed as
 * {@link StartOptions.Builder#controlPoints(LocalControlPoints)}. It holds local values only: in remote mode call
 * sites keep {@code false} as their default, so this file can never switch a feature on in
 * production.
 */
public final class LocalControlPoints {

    private static final LocalControlPoints NONE = new LocalControlPoints(Collections.emptyMap());

    /** Sorted by key, so the signature and iteration order never depend on the caller's map. */
    private final Map<String, LocalControlPoint> entries;

    private LocalControlPoints(Map<String, LocalControlPoint> entries) {
        this.entries = Collections.unmodifiableMap(new LinkedHashMap<>(entries));
    }

    /** No control points: every read gets its default in local mode. */
    public static LocalControlPoints none() {
        return NONE;
    }

    /**
     * Checks every key with the core's control point key rule and returns an immutable copy.
     * Throws {@link FireweaveException} (kind {@code Configuration}) for a null map, key or value,
     * or a key the core would reject.
     */
    static LocalControlPoints of(Map<String, LocalControlPoint> controlPoints) {
        if (controlPoints == null) {
            throw configError("controlPoints: the map is null. Pass LocalControlPoints.none() for none.");
        }
        Map<String, LocalControlPoint> sorted = new TreeMap<>();
        for (Map.Entry<String, LocalControlPoint> e : controlPoints.entrySet()) {
            String key = e.getKey();
            if (key == null) {
                throw configError("controlPoints: a key is null.");
            }
            Validated<String> valid = Validation.validateControlPointKey(key);
            if (!valid.isOk()) {
                throw configError("controlPoints: " + describeKey(key) + " is not a valid control point key ("
                        + valid.error().getMessage() + ").");
            }
            if (e.getValue() == null) {
                throw configError("controlPoints: " + describeKey(key) + " has no LocalControlPoint. Use LocalControlPoint.local(true) or LocalControlPoint.local(false).");
            }
            sorted.put(key, e.getValue());
        }
        return sorted.isEmpty() ? NONE : new LocalControlPoints(sorted);
    }

    /** Every control point, by key (sorted). Unmodifiable. */
    public Map<String, LocalControlPoint> asMap() {
        return entries;
    }

    public int size() {
        return entries.size();
    }

    public boolean contains(String key) {
        return key != null && entries.containsKey(key);
    }

    /** The core local adapter's seed map. */
    Map<String, Boolean> localValues() {
        Map<String, Boolean> out = new LinkedHashMap<>();
        for (Map.Entry<String, LocalControlPoint> e : entries.entrySet()) {
            out.put(e.getKey(), e.getValue().localValue());
        }
        return out;
    }

    /** A canonical rendering of the local values, for the idempotency check. */
    String signature() {
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, LocalControlPoint> e : entries.entrySet()) {
            sb.append(e.getKey().length()).append(':').append(e.getKey())
                    .append('=').append(e.getValue().localValue()).append(';');
        }
        return sb.toString();
    }

    /**
     * A key quoted for an error message: control characters escaped and long keys cut, so a
     * malformed key cannot break a log line.
     */
    private static String describeKey(String key) {
        StringBuilder sb = new StringBuilder("\"");
        int limit = Math.min(key.length(), 64);
        for (int i = 0; i < limit; i++) {
            char c = key.charAt(i);
            if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) {
                sb.append(String.format("\\u%04x", (int) c));
            } else {
                sb.append(c);
            }
        }
        if (key.length() > limit) {
            sb.append("...");
        }
        return sb.append('"').toString();
    }

    private static FireweaveException configError(String message) {
        return new FireweaveException(ErrorKind.Configuration, message);
    }

    @Override
    public boolean equals(Object o) {
        return o instanceof LocalControlPoints && entries.equals(((LocalControlPoints) o).entries);
    }

    @Override
    public int hashCode() {
        return entries.hashCode();
    }

    @Override
    public String toString() {
        return "LocalControlPoints" + entries;
    }
}
