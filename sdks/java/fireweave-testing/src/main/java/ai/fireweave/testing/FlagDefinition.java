package ai.fireweave.testing;

import ai.fireweave.sdk.FlagType;
import ai.fireweave.sdk.JsonValue;
import com.fasterxml.jackson.databind.JsonNode;

import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Deterministic fixture flag definition consumed by {@link InMemoryAdapter}. Mirrors the
 * {@code given.flags.<key>} shape in contracts fixtures.
 */
public final class FlagDefinition {

    private final FlagType type;
    private final boolean enabled;
    private final String variant;
    private final JsonValue value;
    private final JsonValue payload;
    private final String fireweaveReason;
    private final String reasonCode;
    private final Integer conditionIndex;
    private final Number metadataVersion;
    private final Number metadataId;
    private final boolean fromCache;
    private final String matchTargetingKey;
    private final Map<String, JsonValue> matchAttribute;
    private final Map<String, String> matchGroups;
    private final Map<String, JsonValue> matchPerson;

    private FlagDefinition(FlagType type, boolean enabled, String variant, JsonValue value,
                           JsonValue payload, String fireweaveReason, String reasonCode,
                           Integer conditionIndex, Number metadataVersion, Number metadataId,
                           boolean fromCache, String matchTargetingKey,
                           Map<String, JsonValue> matchAttribute, Map<String, String> matchGroups,
                           Map<String, JsonValue> matchPerson) {
        this.type = type;
        this.enabled = enabled;
        this.variant = variant;
        this.value = value;
        this.payload = payload;
        this.fireweaveReason = fireweaveReason;
        this.reasonCode = reasonCode;
        this.conditionIndex = conditionIndex;
        this.metadataVersion = metadataVersion;
        this.metadataId = metadataId;
        this.fromCache = fromCache;
        this.matchTargetingKey = matchTargetingKey;
        this.matchAttribute = matchAttribute;
        this.matchGroups = matchGroups;
        this.matchPerson = matchPerson;
    }

    public static FlagDefinition fromJson(JsonNode node) {
        FlagType type = FlagType.fromCanonical(node.path("type").asText("boolean"));
        boolean enabled = node.path("enabled").asBoolean(true);
        String variant = node.hasNonNull("variant") ? node.get("variant").asText() : null;
        JsonValue value = Json.fromJackson(node.get("value"));
        JsonValue payload = node.hasNonNull("payload") ? Json.fromJackson(node.get("payload")) : null;
        String fireweaveReason = node.hasNonNull("fireweaveReason") ? node.get("fireweaveReason").asText() : null;

        String reasonCode = null;
        Integer conditionIndex = null;
        JsonNode reason = node.get("reason");
        if (reason != null && reason.isObject()) {
            reasonCode = reason.hasNonNull("code") ? reason.get("code").asText() : null;
            conditionIndex = reason.hasNonNull("condition_index") ? reason.get("condition_index").intValue() : null;
        }

        Number metadataVersion = null;
        Number metadataId = null;
        JsonNode metadata = node.get("metadata");
        if (metadata != null && metadata.isObject()) {
            metadataVersion = metadata.hasNonNull("version") ? metadata.get("version").numberValue() : null;
            metadataId = metadata.hasNonNull("id") ? metadata.get("id").numberValue() : null;
        }

        boolean fromCache = node.path("fromCache").asBoolean(false);
        String matchTargetingKey = node.hasNonNull("matchTargetingKey")
                ? node.get("matchTargetingKey").asText() : null;

        Map<String, JsonValue> matchAttribute = readJsonMap(node.get("matchAttribute"));
        Map<String, JsonValue> matchPerson = readJsonMap(node.get("matchPerson"));

        Map<String, String> matchGroups = Collections.emptyMap();
        JsonNode groups = node.get("matchGroups");
        if (groups != null && groups.isObject()) {
            Map<String, String> m = new LinkedHashMap<>();
            Iterator<Map.Entry<String, JsonNode>> it = groups.fields();
            while (it.hasNext()) {
                Map.Entry<String, JsonNode> e = it.next();
                m.put(e.getKey(), e.getValue().asText());
            }
            matchGroups = m;
        }

        return new FlagDefinition(type, enabled, variant, value, payload, fireweaveReason,
                reasonCode, conditionIndex, metadataVersion, metadataId, fromCache,
                matchTargetingKey, matchAttribute, matchGroups, matchPerson);
    }

    private static Map<String, JsonValue> readJsonMap(JsonNode node) {
        if (node == null || !node.isObject()) {
            return Collections.emptyMap();
        }
        Map<String, JsonValue> m = new LinkedHashMap<>();
        Iterator<Map.Entry<String, JsonNode>> it = node.fields();
        while (it.hasNext()) {
            Map.Entry<String, JsonNode> e = it.next();
            m.put(e.getKey(), Json.fromJackson(e.getValue()));
        }
        return m;
    }

    public FlagType type() {
        return type;
    }

    public boolean enabled() {
        return enabled;
    }

    public String variant() {
        return variant;
    }

    public JsonValue value() {
        return value;
    }

    public JsonValue payload() {
        return payload;
    }

    public String fireweaveReason() {
        return fireweaveReason;
    }

    public String reasonCode() {
        return reasonCode;
    }

    public Integer conditionIndex() {
        return conditionIndex;
    }

    public Number metadataVersion() {
        return metadataVersion;
    }

    public Number metadataId() {
        return metadataId;
    }

    public boolean fromCache() {
        return fromCache;
    }

    public String matchTargetingKey() {
        return matchTargetingKey;
    }

    public Map<String, JsonValue> matchAttribute() {
        return matchAttribute;
    }

    public Map<String, String> matchGroups() {
        return matchGroups;
    }

    public Map<String, JsonValue> matchPerson() {
        return matchPerson;
    }
}
