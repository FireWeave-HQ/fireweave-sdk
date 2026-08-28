package ai.fireweave.sdk.domain;

import java.util.Collections;
import java.util.EnumMap;
import java.util.EnumSet;
import java.util.Map;
import java.util.Set;

/**
 * Runtime lifecycle state machine (spec {@code fireweave-sdk.schema.json}).
 *
 * <pre>
 * UNINITIALIZED → INITIALIZING → READY ⇄ STALE
 *                     │            │       │
 *                     ├→ FATAL     ├→ ERROR ⇄ READY
 *                     └→ ERROR     └→ SHUTDOWN (terminal, also from any non-terminal state)
 * </pre>
 *
 * <p>Transitions are enforced by {@link FireweaveRuntime} under its state lock.
 */
public enum LifecycleState {
    UNINITIALIZED,
    INITIALIZING,
    READY,
    STALE,
    ERROR,
    FATAL,
    SHUTDOWN;

    private static final Map<LifecycleState, Set<LifecycleState>> ALLOWED;

    static {
        Map<LifecycleState, Set<LifecycleState>> m = new EnumMap<>(LifecycleState.class);
        m.put(UNINITIALIZED, EnumSet.of(INITIALIZING, SHUTDOWN));
        m.put(INITIALIZING, EnumSet.of(READY, ERROR, FATAL, SHUTDOWN));
        m.put(READY, EnumSet.of(STALE, ERROR, FATAL, SHUTDOWN));
        m.put(STALE, EnumSet.of(READY, ERROR, FATAL, SHUTDOWN));
        m.put(ERROR, EnumSet.of(READY, STALE, FATAL, SHUTDOWN));
        m.put(FATAL, EnumSet.of(SHUTDOWN));
        m.put(SHUTDOWN, EnumSet.noneOf(LifecycleState.class));
        ALLOWED = Collections.unmodifiableMap(m);
    }

    public boolean canTransitionTo(LifecycleState next) {
        return ALLOWED.get(this).contains(next);
    }

    /** True when normal evaluation may be served (READY or STALE). */
    public boolean servesEvaluations() {
        return this == READY || this == STALE;
    }

    public boolean isTerminal() {
        return this == SHUTDOWN;
    }
}
