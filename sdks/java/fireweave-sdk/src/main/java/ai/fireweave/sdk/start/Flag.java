package ai.fireweave.sdk.start;

import java.util.Objects;

/**
 * One control point the app reads, with the value served in local mode. Immutable.
 *
 * <pre>{@code
 * Flag.local(true)
 * Flag.local(true, "new checkout flow")
 * }</pre>
 *
 * <p>The local value is ignored in remote mode, where fw-server and the rollout decide; call
 * sites keep {@code false} as their default, so a flags file can never switch a feature on in
 * production.
 */
public final class Flag {

    private final boolean localValue;
    private final String description;

    private Flag(boolean localValue, String description) {
        this.localValue = localValue;
        this.description = description == null ? "" : description;
    }

    /** A control point served as {@code value} in local mode. */
    public static Flag local(boolean value) {
        return new Flag(value, "");
    }

    /**
     * A control point served as {@code value} in local mode, with a note for humans and agents.
     * The description is never sent anywhere.
     */
    public static Flag local(boolean value, String description) {
        return new Flag(value, description);
    }

    /** The value served in local mode. */
    public boolean localValue() {
        return localValue;
    }

    /** The note for humans and agents; "" when none. */
    public String description() {
        return description;
    }

    @Override
    public boolean equals(Object o) {
        if (!(o instanceof Flag)) {
            return false;
        }
        Flag other = (Flag) o;
        return localValue == other.localValue && description.equals(other.description);
    }

    @Override
    public int hashCode() {
        return Objects.hash(localValue, description);
    }

    @Override
    public String toString() {
        return "Flag{local=" + localValue + (description.isEmpty() ? "" : ", description=" + description) + "}";
    }
}
