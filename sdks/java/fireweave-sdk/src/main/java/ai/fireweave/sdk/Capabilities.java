package ai.fireweave.sdk;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Capability matrix snapshot (spec {@code capabilities.schema.json}) returned by
 * {@code FireweaveClient.capabilities().get()}. Immutable.
 */
public final class Capabilities {

    public static final String LANGUAGE = "java";
    public static final String SPEC_VERSION = "0.1.0";
    public static final String SDK_VERSION = "0.1.0-SNAPSHOT";
    public static final String PROVIDER_NAME = "fireweave";
    public static final String OPENFEATURE_SPEC_FLOOR = "0.8.0";
    /** 2^53 - 1 cross-language safe integer bound. */
    public static final long INT_SAFE_MAX_ABS = 9007199254740991L;

    private final String backend;
    private final LifecycleState lifecycle;
    private final Map<String, Boolean> staticFeatures;
    private final Map<String, Boolean> runtimeFeatures;
    private final List<String> capabilityNames;

    Capabilities(String backend,
                 LifecycleState lifecycle,
                 Map<String, Boolean> staticFeatures,
                 Map<String, Boolean> runtimeFeatures,
                 List<String> capabilityNames) {
        this.backend = backend;
        this.lifecycle = lifecycle;
        this.staticFeatures = Collections.unmodifiableMap(new LinkedHashMap<>(staticFeatures));
        this.runtimeFeatures = Collections.unmodifiableMap(new LinkedHashMap<>(runtimeFeatures));
        this.capabilityNames = Collections.unmodifiableList(new ArrayList<>(capabilityNames));
    }

    public String backend() {
        return backend;
    }

    public LifecycleState lifecycle() {
        return lifecycle;
    }

    public Map<String, Boolean> staticFeatures() {
        return staticFeatures;
    }

    public Map<String, Boolean> runtimeFeatures() {
        return runtimeFeatures;
    }

    /** Negotiated dotted capability names, e.g. "releases.setContext" (dynamic dispatch sugar). */
    public List<String> names() {
        return capabilityNames;
    }

    public boolean supports(String capabilityName) {
        return capabilityNames.contains(capabilityName);
    }

    /**
     * Canonical structured {@code {static, runtime}} capability matrix per
     * {@code spec/capabilities.schema.json} (orchestrator ruling 18: capabilities.get is the
     * structured matrix, never a flat capability-string list).
     */
    public JsonValue toJsonValue() {
        Map<String, JsonValue> openFeature = new LinkedHashMap<>();
        openFeature.put("specFloor", JsonValue.of(OPENFEATURE_SPEC_FLOOR));
        openFeature.put("providerName", JsonValue.of(PROVIDER_NAME));
        openFeature.put("serverOnly", JsonValue.of(true));

        Map<String, JsonValue> staticFeaturesJson = new LinkedHashMap<>();
        staticFeatures.forEach((k, v) -> staticFeaturesJson.put(k, JsonValue.of(v)));

        Map<String, JsonValue> staticNode = new LinkedHashMap<>();
        staticNode.put("language", JsonValue.of(LANGUAGE));
        staticNode.put("sdkVersion", JsonValue.of(SDK_VERSION));
        staticNode.put("specVersion", JsonValue.of(SPEC_VERSION));
        staticNode.put("openFeature", JsonValue.ofObject(openFeature));
        staticNode.put("features", JsonValue.ofObject(staticFeaturesJson));

        Map<String, JsonValue> runtimeFeaturesJson = new LinkedHashMap<>();
        runtimeFeatures.forEach((k, v) -> runtimeFeaturesJson.put(k, JsonValue.of(v)));

        Map<String, JsonValue> limits = new LinkedHashMap<>();
        limits.put("intSafeMaxAbs", JsonValue.of(INT_SAFE_MAX_ABS));
        limits.put("shutdownTimeoutMsDefault", JsonValue.of(FireweaveConfig.DEFAULT_SHUTDOWN_TIMEOUT_MS));

        Map<String, JsonValue> runtimeNode = new LinkedHashMap<>();
        runtimeNode.put("backend", JsonValue.of(backend));
        runtimeNode.put("lifecycle", JsonValue.of(lifecycle.name()));
        runtimeNode.put("features", JsonValue.ofObject(runtimeFeaturesJson));
        runtimeNode.put("limits", JsonValue.ofObject(limits));

        Map<String, JsonValue> root = new LinkedHashMap<>();
        root.put("static", JsonValue.ofObject(staticNode));
        root.put("runtime", JsonValue.ofObject(runtimeNode));
        return JsonValue.ofObject(root);
    }
}
