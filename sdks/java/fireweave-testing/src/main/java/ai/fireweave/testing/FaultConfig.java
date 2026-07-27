package ai.fireweave.testing;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Deterministic fault simulation for {@link InMemoryAdapter} (mirrors {@code given.fault} in
 * contracts fixtures). Faults are simulated in-process — no HTTP, no sleeping: a delay fault
 * simply compares {@code delayMs} against the configured request timeout.
 */
public final class FaultConfig {

    public enum Mode { HTTP_STATUS, INVALID_JSON, NETWORK_ERROR, OFFLINE, QUOTA_LIMITED, DELAY }

    private final Mode mode;
    private final int status;
    private final long delayMs;
    private final String applyTo;
    private final List<String> quotaLimited;

    private FaultConfig(Mode mode, int status, long delayMs, String applyTo, List<String> quotaLimited) {
        this.mode = mode;
        this.status = status;
        this.delayMs = delayMs;
        this.applyTo = applyTo;
        this.quotaLimited = quotaLimited;
    }

    public static FaultConfig fromJson(JsonNode node) {
        if (node == null || !node.isObject()) {
            return null;
        }
        String modeStr = node.path("mode").asText("");
        Mode mode;
        switch (modeStr) {
            case "httpStatus":
                mode = Mode.HTTP_STATUS;
                break;
            case "invalidJson":
                mode = Mode.INVALID_JSON;
                break;
            case "networkError":
                mode = Mode.NETWORK_ERROR;
                break;
            case "offline":
                mode = Mode.OFFLINE;
                break;
            case "quotaLimited":
                mode = Mode.QUOTA_LIMITED;
                break;
            case "delay":
                mode = Mode.DELAY;
                break;
            default:
                throw new IllegalArgumentException("unknown fault mode: " + modeStr);
        }
        List<String> quota = new ArrayList<>();
        JsonNode q = node.get("quotaLimited");
        if (q != null && q.isArray()) {
            q.forEach(x -> quota.add(x.asText()));
        }
        return new FaultConfig(mode,
                node.path("status").asInt(0),
                node.path("delayMs").asLong(0),
                node.hasNonNull("applyTo") ? node.get("applyTo").asText() : null,
                Collections.unmodifiableList(quota));
    }

    public Mode mode() {
        return mode;
    }

    public int status() {
        return status;
    }

    public long delayMs() {
        return delayMs;
    }

    /** e.g. "definitions" — fault hits the definitions poll, not the evaluation path. */
    public String applyTo() {
        return applyTo;
    }

    public List<String> quotaLimited() {
        return quotaLimited;
    }
}
