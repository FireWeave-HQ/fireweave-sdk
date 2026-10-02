package ai.fireweave.sdk.start;

import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Every name the start profile reads, in one place, so the README, the initialise skill and the
 * error messages cannot drift apart (node: src/start/names.ts, go: fw/names.go).
 */
final class Names {

    private Names() {
    }

    // Env vars the start profile reads. Explicit StartOptions always win.
    static final String ENV_KEY = "FIREWEAVE_KEY";
    static final String ENV_URL = "FIREWEAVE_URL";
    static final String ENV_ENVIRONMENT = "FIREWEAVE_ENV";
    static final String ENV_INSTANCE_ID = "FIREWEAVE_INSTANCE_ID";

    /** Read for the instance key before the operating system is asked (node does the same). */
    static final String ENV_HOSTNAME = "HOSTNAME";

    /**
     * Legacy names written by the scaffolded harness. Read only when the replacement is unset,
     * with one warning per name, for the whole 2.x line (docs/versioning.md: documented
     * configuration is removed only in a major).
     */
    static final List<String> LEGACY_KEY_NAMES = Collections.singletonList("FW_PROJECT_API_KEY");
    static final List<String> LEGACY_URL_NAMES =
            Collections.unmodifiableList(Arrays.asList("FW_API_URL", "FW_ATTEST_URL"));

    /**
     * Read after StartOptions.environment and FIREWEAVE_ENV. NODE_ENV is not a Java convention:
     * only names an operator sets on purpose select a mode.
     */
    static final List<String> ENVIRONMENT_FALLBACKS = Collections.singletonList("APP_ENV");

    /** Read only to explain a start error: the scaffolded harness's FW_ENV is no longer honoured. */
    static final String RETIRED_ENVIRONMENT_NAME = "FW_ENV";

    /** Environment names that mean "local development" when no key is set (trimmed, any case). */
    static final Set<String> DEV_ENVIRONMENTS = Collections.unmodifiableSet(
            new LinkedHashSet<>(Arrays.asList("development", "dev", "local", "test")));

    /**
     * fw-server host per release channel. Both are in the core's
     * {@code FireweaveConfig.DEFAULT_ALLOWED_HOSTS}, so the default endpoint needs no custom
     * allowlist.
     */
    static final String PRODUCTION_URL = "https://app-server.fireweave.ai";
    static final String STAGING_URL = "https://staging-app-server.fireweave.ai";

    /** Always allowed beside a custom endpoint, so local stacks keep working. */
    static final List<String> LOOPBACK_HOSTS =
            Collections.unmodifiableList(Arrays.asList("localhost", "127.0.0.1", "::1"));

    /** Where the app's flags conventionally live; named in the local-mode "missing key" warning. */
    static final String FLAGS_FILE = "FireweaveFlags.java";

    static String channelUrl(SdkChannel channel) {
        return channel == SdkChannel.STAGING ? STAGING_URL : PRODUCTION_URL;
    }
}
