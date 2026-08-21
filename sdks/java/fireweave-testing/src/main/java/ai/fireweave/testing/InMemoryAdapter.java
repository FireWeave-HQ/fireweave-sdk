package ai.fireweave.testing;

import ai.fireweave.sdk.application.BackendAdapter;
import ai.fireweave.sdk.application.EvaluationRequest;
import ai.fireweave.sdk.application.FireweaveConfig;
import ai.fireweave.sdk.domain.Decision;
import ai.fireweave.sdk.domain.ErrorKind;
import ai.fireweave.sdk.domain.EvaluationContext;
import ai.fireweave.sdk.domain.FireweaveException;
import ai.fireweave.sdk.domain.FlagType;
import ai.fireweave.sdk.domain.JsonValue;
import ai.fireweave.sdk.domain.Reasons;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Deterministic, fixture-driven {@link BackendAdapter} for conformance and unit tests.
 * Resolution model mirrors contracts/ fixture flag definitions: flags, variants, payloads,
 * targeting by targeting key / person attributes / groups. Deliberately NO bucketing /
 * percentage logic (mirrors node/go/python's InMemoryAdapter).
 */
public final class InMemoryAdapter implements BackendAdapter {

    /** One deterministic flag definition, mirroring contracts/ fixture given.flags shape. */
    public static final class FlagDefinition {
        public FlagType type;
        public boolean enabled;
        public String variant;
        public JsonValue value;
        public String reasonCode;
        public Integer conditionIndex;
        public Long version;
        public Long vendorId;
        /** Canonical reason override (fixtures: "SPLIT"). */
        public String fireweaveReason;
        /** Served from last-good cache (stale scenarios). */
        public boolean fromCache;
        public String matchTargetingKey;
        public Map<String, JsonValue> matchAttribute;
        public Map<String, String> matchGroups;
        public Map<String, JsonValue> matchPerson;
    }

    private volatile Map<String, FlagDefinition> flags;
    private volatile boolean stale;
    private volatile FireweaveException fault;
    private volatile boolean closed;
    private final AtomicLong resolveCount = new AtomicLong();
    private volatile EvaluationContext lastContext;

    public InMemoryAdapter(Map<String, FlagDefinition> flags) {
        this.flags = new ConcurrentHashMap<>(flags == null ? Collections.emptyMap() : flags);
    }

    public void setFlags(Map<String, FlagDefinition> flags) {
        this.flags = new ConcurrentHashMap<>(flags == null ? Collections.emptyMap() : flags);
    }

    /** Fault to throw on every resolve (fault-mode conformance without HTTP). */
    public void setFault(FireweaveException fault) {
        this.fault = fault;
    }

    public long resolveCount() {
        return resolveCount.get();
    }

    /** Most recently resolved context, for resolvedContext observations. */
    public EvaluationContext lastContext() {
        return lastContext;
    }

    /** Marks this adapter as serving a stale snapshot (fault-stale-cache; STALE providerState). */
    public void setStale(boolean stale) {
        this.stale = stale;
    }

    @Override
    public String name() {
        return "inmemory";
    }

    @Override
    public void initialize(FireweaveConfig config) {
        closed = false;
    }

    @Override
    public boolean isStale() {
        return stale;
    }

    @Override
    public Decision evaluate(EvaluationRequest request) throws FireweaveException {
        resolveCount.incrementAndGet();
        lastContext = request.context();
        if (closed) {
            throw new FireweaveException(ErrorKind.AlreadyClosed);
        }
        if (fault != null) {
            throw fault;
        }
        FlagDefinition def = flags.get(request.flagKey());
        if (def == null) {
            throw new FireweaveException(ErrorKind.FlagNotFound);
        }
        if (def.type != request.type()) {
            throw new FireweaveException(ErrorKind.TypeMismatch);
        }
        if (!matches(def, request.context())) {
            return Decision.builder(request.flagKey())
                    .value(request.defaultValue())
                    .reason(Reasons.DEFAULT)
                    .build();
        }

        Decision.Builder b = Decision.builder(request.flagKey())
                .value(def.value)
                .variant(def.variant);
        if (!def.enabled) {
            b.reason(Reasons.DISABLED);
        } else if (def.fromCache) {
            b.reason(Reasons.STALE);
        } else if (def.fireweaveReason != null) {
            b.reason(def.fireweaveReason);
        } else {
            b.reason(Reasons.TARGETING_MATCH);
        }
        if (def.version != null) {
            b.metadata("fireweave.flagVersion", def.version);
        }
        // Detailed vendor fields travel together: only when the backend reports BOTH a
        // vendor flag id AND a matched condition index (mirrors node/go/python).
        if (def.vendorId != null && def.conditionIndex != null) {
            b.metadata("fireweave.vendorFlagId", def.vendorId);
            if (def.reasonCode != null) {
                b.metadata("fireweave.reasonCode", def.reasonCode);
            }
        }
        if (def.fromCache) {
            b.metadata("fireweave.fromCache", true);
        }
        return b.build();
    }

    private boolean matches(FlagDefinition def, EvaluationContext ctx) {
        if (def.matchTargetingKey != null && !def.matchTargetingKey.equals(ctx.targetingKey())) {
            return false;
        }
        if (def.matchAttribute != null) {
            for (Map.Entry<String, JsonValue> e : def.matchAttribute.entrySet()) {
                if (!e.getValue().equals(ctx.attributes().get(e.getKey()))) {
                    return false;
                }
            }
        }
        if (def.matchGroups != null) {
            for (Map.Entry<String, String> e : def.matchGroups.entrySet()) {
                if (!e.getValue().equals(ctx.groups().get(e.getKey()))) {
                    return false;
                }
            }
        }
        if (def.matchPerson != null) {
            for (Map.Entry<String, JsonValue> e : def.matchPerson.entrySet()) {
                if (!e.getValue().equals(ctx.attributes().get(e.getKey()))) {
                    return false;
                }
            }
        }
        return true;
    }

    @Override
    public void shutdown() {
        closed = true;
    }

    public boolean isClosed() {
        return closed;
    }

    /** Empty flag table convenience. */
    public static InMemoryAdapter empty() {
        return new InMemoryAdapter(new LinkedHashMap<>());
    }
}
