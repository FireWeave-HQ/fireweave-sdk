package ai.fireweave.sdk.start;

import ai.fireweave.sdk.domain.ErrorKind;
import ai.fireweave.sdk.domain.Mode;

/**
 * What the start profile decided ({@link Fw#status()}). It never contains the key, so it is safe
 * to log. Immutable.
 */
public final class StartStatus {

    private final StartState state;
    private final Mode mode;
    private final String modeSource;
    private final SdkChannel channel;
    private final String sdkVersion;
    private final String host;
    private final String endpointSource;
    private final String keySource;
    private final String environment;
    private final int controlPointCount;
    private final String error;
    private final ErrorKind lastErrorKind;

    StartStatus(StartState state, Mode mode, String modeSource, SdkChannel channel, String sdkVersion,
                String host, String endpointSource, String keySource, String environment, int controlPointCount,
                String error, ErrorKind lastErrorKind) {
        this.state = state;
        this.mode = mode;
        this.modeSource = modeSource;
        this.channel = channel;
        this.sdkVersion = sdkVersion;
        this.host = host;
        this.endpointSource = endpointSource;
        this.keySource = keySource;
        this.environment = environment;
        this.controlPointCount = controlPointCount;
        this.error = error;
        this.lastErrorKind = lastErrorKind;
    }

    public StartState state() {
        return state;
    }

    /** The mode a start resolved, or null before one did. */
    public Mode mode() {
        return mode;
    }

    /** Why that mode: {@code option}, {@code key} or {@code environment}; null before a start. */
    public String modeSource() {
        return modeSource;
    }

    public SdkChannel channel() {
        return channel;
    }

    public String sdkVersion() {
        return sdkVersion;
    }

    /** The fw-server host name only (remote mode), never a path or a credential; null otherwise. */
    public String host() {
        return host;
    }

    /**
     * Where the endpoint came from: {@code StartOptions.url}, a variable name, or
     * {@code SDK channel (…)}; null in local mode.
     */
    public String endpointSource() {
        return endpointSource;
    }

    /** {@code StartOptions.key} or the variable the key came from; {@code none} in local mode. */
    public String keySource() {
        return keySource;
    }

    /** The environment name, when it chose the mode; null otherwise. */
    public String environment() {
        return environment;
    }

    public int controlPointCount() {
        return controlPointCount;
    }

    /** Why start failed, when it did (already redacted); null otherwise. */
    public String error() {
        return error;
    }

    /**
     * The latest failure the started client got back from fw-server that means the key was
     * refused ({@code Authentication} for 401, {@code Authorization} for 403), throttled
     * ({@code RateLimited}, 429) or fw-server could not be reached ({@code Network},
     * {@code Timeout}, {@code BackendUnavailable}); null when there was none since start. Each of
     * these kinds is also logged once per process. Reads keep serving defaults meanwhile.
     */
    public ErrorKind lastErrorKind() {
        return lastErrorKind;
    }

    @Override
    public String toString() {
        return "StartStatus{state=" + state
                + ", mode=" + mode
                + ", modeSource=" + modeSource
                + ", channel=" + channel
                + ", sdkVersion=" + sdkVersion
                + ", host=" + host
                + ", endpointSource=" + endpointSource
                + ", keySource=" + keySource
                + ", environment=" + environment
                + ", controlPointCount=" + controlPointCount
                + ", error=" + error
                + ", lastErrorKind=" + lastErrorKind + "}";
    }
}
