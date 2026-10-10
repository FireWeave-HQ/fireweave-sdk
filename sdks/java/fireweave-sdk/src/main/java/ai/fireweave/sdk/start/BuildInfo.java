package ai.fireweave.sdk.start;

import java.io.IOException;
import java.io.InputStream;
import java.util.Properties;

/**
 * This SDK build's version and release channel.
 *
 * <p>{@code build.properties} beside this class is filtered by Maven
 * ({@code fireweave-sdk/pom.xml}) to {@code version=${project.version}}. tools/release/version.sh
 * writes a Java staging release as {@code X.Y.Z-rc.N}, so that is what a staging artifact
 * carries; a production release is {@code X.Y.Z}, and a local build {@code X.Y.Z-SNAPSHOT}.
 */
final class BuildInfo {

    /** Reported when the resource is missing or was never filtered (an IDE build, a repackager). */
    static final String DEVEL_VERSION = "(devel)";

    private static final String RESOURCE = "build.properties";

    private BuildInfo() {
    }

    /**
     * The channel rule, as a pure function of a version string: a {@code -rc.} version is
     * staging; anything else, including {@code (devel)}, {@code -SNAPSHOT} and {@code -staging.N}
     * (no longer a staging spelling from 3.0.0), is production.
     */
    static SdkChannel channelForVersion(String version) {
        return version != null && version.contains("-rc.") ? SdkChannel.STAGING : SdkChannel.PRODUCTION;
    }

    /** The version recorded in {@code in}, or {@link #DEVEL_VERSION}. Never throws. */
    static String versionFrom(InputStream in) {
        if (in == null) {
            return DEVEL_VERSION;
        }
        Properties properties = new Properties();
        try (InputStream stream = in) {
            properties.load(stream);
        } catch (IOException | RuntimeException e) {
            return DEVEL_VERSION;
        }
        String version = properties.getProperty("version", "").trim();
        if (version.isEmpty() || version.contains("${")) {
            return DEVEL_VERSION;
        }
        return version;
    }

    static String version() {
        return Holder.VERSION;
    }

    static SdkChannel channel() {
        return channelForVersion(version());
    }

    /** Read once, on first use. */
    private static final class Holder {
        static final String VERSION = versionFrom(BuildInfo.class.getResourceAsStream(RESOURCE));
    }
}
