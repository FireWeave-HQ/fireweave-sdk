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
 * mode. Built by {@link Fw#defineFlags(Map)}, which checks every key; immutable.
 *
 * <p>It conventionally lives in its own class ({@code FireweaveFlags.java}) and is passed as
 * {@link StartOptions.Builder#flags(Flags)}. It holds local values only: in remote mode call
 * sites keep {@code false} as their default, so a flags file can never switch a feature on in
 * production.
 */
public final class Flags {

    private static final Flags NONE = new Flags(Collections.emptyMap());

    /** Sorted by key, so the signature and iteration order never depend on the caller's map. */
    private final Map<String, Flag> entries;

    private Flags(Map<String, Flag> entries) {
        this.entries = Collections.unmodifiableMap(new LinkedHashMap<>(entries));
    }

    /** No flags: every read gets its default in local mode. */
    public static Flags none() {
        return NONE;
    }

    /**
     * Checks every key with the core's control point key rule and returns an immutable copy.
     * Throws {@link FireweaveException} (kind {@code Configuration}) for a null map, key or flag,
     * or a key the core would reject.
     */
    static Flags of(Map<String, Flag> flags) {
        if (flags == null) {
            throw configError("flags: the map is null. Pass Flags.none() for no flags.");
        }
        Map<String, Flag> sorted = new TreeMap<>();
        for (Map.Entry<String, Flag> e : flags.entrySet()) {
            String key = e.getKey();
            if (key == null) {
                throw configError("flags: a key is null.");
            }
            Validated<String> valid = Validation.validateControlPointKey(key);
            if (!valid.isOk()) {
                throw configError("flags: " + describeKey(key) + " is not a valid control point key ("
                        + valid.error().getMessage() + ").");
            }
            if (e.getValue() == null) {
                throw configError("flags: " + describeKey(key) + " has no Flag. Use Flag.local(true) or Flag.local(false).");
            }
            sorted.put(key, e.getValue());
        }
        return sorted.isEmpty() ? NONE : new Flags(sorted);
    }

    /** Every flag, by key (sorted). Unmodifiable. */
    public Map<String, Flag> asMap() {
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
        for (Map.Entry<String, Flag> e : entries.entrySet()) {
            out.put(e.getKey(), e.getValue().localValue());
        }
        return out;
    }

    /** A canonical rendering of the local values, for the idempotency check. */
    String signature() {
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, Flag> e : entries.entrySet()) {
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
        return o instanceof Flags && entries.equals(((Flags) o).entries);
    }

    @Override
    public int hashCode() {
        return entries.hashCode();
    }

    @Override
    public String toString() {
        return "Flags" + entries;
    }
}
