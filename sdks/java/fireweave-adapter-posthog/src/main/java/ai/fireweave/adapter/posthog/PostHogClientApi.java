package ai.fireweave.adapter.posthog;

import ai.fireweave.sdk.JsonValue;

import java.util.Map;

/**
 * Internal transport seam mirroring the posthog-server 2.9.0 surface the adapter needs
 * (ADR-0002). This is a Fireweave-owned interface — no vendor types cross it — so the adapter's
 * mapping logic is implemented and testable (fake client) while the real artifact is unavailable
 * (com.posthog:posthog-server:2.9.0 is not on Maven Central as of 2026-07-27; binding blocked,
 * reported for arbitration).
 *
 * <p>Design notes vs the vendor SDK:
 * <ul>
 *   <li><b>Explicit context passing:</b> every call carries the full identity/properties — the
 *       vendor SDK's ThreadLocal request context is intentionally not used, so Fireweave context
 *       flow is deterministic across threads.</li>
 *   <li><b>Snapshot evaluation:</b> one {@link #evaluateFlags} call returns all flags for the
 *       subject (the /flags?v=2 shape), which the adapter resolves locally per flag key.</li>
 * </ul>
 *
 * <p>Implementations must be thread-safe.
 */
public interface PostHogClientApi extends AutoCloseable {

    /**
     * Remote (or local-eval) snapshot evaluation for one subject.
     *
     * @throws PostHogTransportException on HTTP/transport/parse failures
     */
    PostHogFlagsSnapshot evaluateFlags(String distinctId,
                                       Map<String, JsonValue> personProperties,
                                       Map<String, String> groups,
                                       Map<String, Map<String, JsonValue>> groupProperties)
            throws PostHogTransportException;

    /** Capture an event (e.g. {@code $feature_flag_called} exposure, signal bridge). */
    void capture(String distinctId, String event, Map<String, JsonValue> properties)
            throws PostHogTransportException;

    @Override
    void close();
}
