package ai.fireweave.sdk.start;

import java.util.Locale;

/**
 * The release channel this SDK build came from. It chooses the default fw-server endpoint
 * (docs/adr/0011-start-profile.md, rule 3): see {@link Fw#sdkChannel()}.
 */
public enum SdkChannel {
    PRODUCTION,
    STAGING;

    /** Lower-case name, as node and Go spell it ({@code production}, {@code staging}). */
    @Override
    public String toString() {
        return name().toLowerCase(Locale.ROOT);
    }
}
