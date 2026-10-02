package ai.fireweave.sdk.start;

import ai.fireweave.sdk.domain.ErrorKind;
import ai.fireweave.sdk.domain.FireweaveException;
import ai.fireweave.sdk.domain.Mode;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.function.Function;
import java.util.regex.Pattern;

/**
 * The pure start-profile resolver: options + variable lookup + build channel in, one
 * {@link Resolved} out. No I/O and no globals, so every rule is unit-tested through
 * {@link #resolve} alone (node: src/start/resolve.ts, go: fw/resolve.go).
 *
 * <p>Precedence for every value: explicit option, then the {@code FIREWEAVE_*} variable, then the
 * legacy {@code FW_*} name (one warning), then the default. Lookups are lazy: a source is read
 * only if every earlier source was unset.
 */
final class StartResolver {

    static final String MODE_SOURCE_OPTION = "option";
    static final String MODE_SOURCE_KEY = "key";
    static final String MODE_SOURCE_ENVIRONMENT = "environment";

    /**
     * Analytics-vendor key shapes. A pattern rather than literal prefixes, and messages say
     * "analytics vendor key", so no vendor key prefix appears in this file or in an error.
     */
    private static final Pattern VENDOR_KEY = Pattern.compile("^ph[a-z]_");

    /** The rule for quoting an environment name back in an error: a short plain token. */
    private static final Pattern SAFE_ECHO = Pattern.compile("^[A-Za-z0-9._-]{1,32}$");

    private StartResolver() {
    }

    /** One value and where it came from (an option name or a variable name). */
    static final class Sourced {
        final String value;
        final String source;

        Sourced(String value, String source) {
            this.value = value;
            this.source = source;
        }
    }

    /**
     * One start decision. {@code key} is held only to hand it to {@code Fireweave.init}; it is
     * never logged, printed or put in a status.
     */
    static final class Resolved {
        Mode mode;
        String modeSource;

        // Remote only.
        String url;
        String urlSource;
        /** Null when the default channel endpoint is used (the core's default allowlist admits it). */
        List<String> allowedHosts;
        String key;
        /** {@code none} in local mode. */
        String keySource = "none";

        // Set when the environment name chose local mode.
        String environment;
        String environmentSource;

        Flags flags = Flags.none();
        SdkChannel channel;
        String sdkVersion;

        /** Lines to log once each: legacy names, an ignored key. */
        final List<String> warnings = new ArrayList<>();

        @Override
        public String toString() {
            return "Resolved{mode=" + mode + ", modeSource=" + modeSource + ", url=" + url
                    + ", keySource=" + keySource + ", environment=" + environment + "}";
        }
    }

    /**
     * Applies the start profile's rules. {@code lookup} returns a trimmed value, "" for unset.
     *
     * @throws FireweaveException kind {@code Configuration}, naming the option or variable at
     *     fault and never a key
     */
    static Resolved resolve(StartOptions options, Function<String, String> lookup, String sdkVersion,
                            SdkChannel channel) {
        StartOptions opts = options == null ? StartOptions.defaults() : options;
        Resolved r = new Resolved();
        r.flags = opts.flags();
        r.channel = channel;
        r.sdkVersion = sdkVersion;

        Mode mode = opts.mode();
        if (mode == Mode.LOCAL) {
            // The key is ignored. Look only to warn.
            Sourced ignored = pick(opts.key(), "StartOptions.key", Collections.singletonList(Names.ENV_KEY),
                    Names.LEGACY_KEY_NAMES, lookup, null, Names.ENV_KEY);
            if (ignored != null) {
                r.warnings.add("[fireweave] StartOptions.mode(LOCAL) ignores the key from " + ignored.source
                        + "; nothing is sent to fw-server.");
            }
            r.mode = Mode.LOCAL;
            r.modeSource = MODE_SOURCE_OPTION;
            return r;
        }

        Sourced key = resolveKey(opts, lookup, r.warnings);
        if (mode == Mode.REMOTE && key == null) {
            throw configError("StartOptions.mode(REMOTE) needs a key. Set " + Names.ENV_KEY
                    + " or pass StartOptions.key.");
        }

        if (key != null) {
            resolveUrl(opts, lookup, r);
            r.mode = Mode.REMOTE;
            r.modeSource = mode == Mode.REMOTE ? MODE_SOURCE_OPTION : MODE_SOURCE_KEY;
            r.key = key.value;
            r.keySource = key.source;
            return r;
        }

        List<String> envNames = new ArrayList<>();
        envNames.add(Names.ENV_ENVIRONMENT);
        envNames.addAll(Names.ENVIRONMENT_FALLBACKS);
        Sourced env = pick(opts.environment(), "StartOptions.environment", envNames,
                Collections.<String>emptyList(), lookup, null, Names.ENV_ENVIRONMENT);
        if (env != null && Names.DEV_ENVIRONMENTS.contains(env.value.toLowerCase(Locale.ROOT))) {
            r.mode = Mode.LOCAL;
            r.modeSource = MODE_SOURCE_ENVIRONMENT;
            r.environment = env.value;
            r.environmentSource = env.source;
            return r;
        }
        throw noKeyError(env, lookup);
    }

    /**
     * The first non-empty of: the option, then each variable in order, then each legacy name
     * (adding one warning naming its replacement). Null when every source is unset.
     */
    static Sourced pick(String option, String optionName, List<String> names, List<String> legacy,
                        Function<String, String> lookup, List<String> warnings, String replacement) {
        String fromOption = StartEnv.trim(option);
        if (!fromOption.isEmpty()) {
            return new Sourced(fromOption, optionName);
        }
        for (String name : names) {
            String v = StartEnv.trim(lookup.apply(name));
            if (!v.isEmpty()) {
                return new Sourced(v, name);
            }
        }
        for (String name : legacy) {
            String v = StartEnv.trim(lookup.apply(name));
            if (!v.isEmpty()) {
                if (warnings != null) {
                    warnings.add("[fireweave] " + name + " is a legacy name and will stop being read in the next "
                            + "major version (3.0.0). Rename it to " + replacement + "; the value does not change.");
                }
                return new Sourced(v, name);
            }
        }
        return null;
    }

    /**
     * Runs before any request. Messages name the source, never the value. Null when the key is
     * of an accepted family.
     */
    static FireweaveException checkKeyFamily(String key, String source) {
        if (key.startsWith("fw_public_")) {
            return configError("The key from " + source + " is a browser key (fw_public_…). Server apps need a "
                    + "project key (project-api-key_…) from Project settings, API keys.");
        }
        if (VENDOR_KEY.matcher(key).find()) {
            return configError("The key from " + source + " is an analytics vendor key, not a FireWeave project "
                    + "key. Use the project key (project-api-key_…).");
        }
        if (key.startsWith("fw_org_") || key.startsWith("cli_at_")) {
            return configError("The key from " + source + " is an organisation or CLI token, not a project key. "
                    + "Use the project key (project-api-key_…).");
        }
        return null;
    }

    private static Sourced resolveKey(StartOptions opts, Function<String, String> lookup, List<String> warnings) {
        Sourced picked = pick(opts.key(), "StartOptions.key", Collections.singletonList(Names.ENV_KEY),
                Names.LEGACY_KEY_NAMES, lookup, warnings, Names.ENV_KEY);
        if (picked == null) {
            return null;
        }
        FireweaveException family = checkKeyFamily(picked.value, picked.source);
        if (family != null) {
            throw family;
        }
        return picked;
    }

    /**
     * Picks the endpoint. The default is this build's channel host, which the core's default
     * allowlist already admits; an override gets an allowlist of its own host plus loopback.
     */
    private static void resolveUrl(StartOptions opts, Function<String, String> lookup, Resolved r) {
        Sourced picked = pick(opts.url(), "StartOptions.url", Collections.singletonList(Names.ENV_URL),
                Names.LEGACY_URL_NAMES, lookup, r.warnings, Names.ENV_URL);
        if (picked == null) {
            r.url = Names.channelUrl(r.channel);
            r.urlSource = "SDK channel (" + r.channel + ")";
            r.allowedHosts = null;
            return;
        }
        String raw = picked.value.replaceAll("/+$", "");
        URI uri;
        try {
            uri = new URI(raw);
        } catch (URISyntaxException e) {
            throw configError("The endpoint from " + picked.source + " is not a valid URL.");
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        String host = normalizeHost(uri.getHost());
        if ((!"http".equals(scheme) && !"https".equals(scheme)) || host.isEmpty()) {
            throw configError("The endpoint from " + picked.source + " is not a valid URL.");
        }
        if (uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null) {
            throw configError("The endpoint from " + picked.source
                    + " must not carry credentials, a query or a fragment.");
        }
        if ("http".equals(scheme) && !Names.LOOPBACK_HOSTS.contains(host)) {
            throw configError("The endpoint from " + picked.source
                    + " must use https (http is allowed only for localhost).");
        }
        List<String> hosts = new ArrayList<>();
        hosts.add(host);
        for (String loopback : Names.LOOPBACK_HOSTS) {
            if (!loopback.equals(host)) {
                hosts.add(loopback);
            }
        }
        r.url = raw;
        r.urlSource = picked.source;
        r.allowedHosts = Collections.unmodifiableList(hosts);
    }

    /** Lower-case, IPv6 brackets stripped (as the core compares hosts); "" for none. */
    static String normalizeHost(String host) {
        if (host == null) {
            return "";
        }
        String out = host.toLowerCase(Locale.ROOT);
        if (out.startsWith("[") && out.endsWith("]")) {
            out = out.substring(1, out.length() - 1);
        }
        return out;
    }

    private static boolean echoable(String value) {
        if (!SAFE_ECHO.matcher(value).matches() || VENDOR_KEY.matcher(value).find()) {
            return false;
        }
        return !value.startsWith("project-api-key_") && !value.startsWith("fw_");
    }

    private static FireweaveException noKeyError(Sourced env, Function<String, String> lookup) {
        String where;
        if (env == null) {
            where = "no environment name is set (checked StartOptions.environment, " + Names.ENV_ENVIRONMENT
                    + " and " + String.join(", ", Names.ENVIRONMENT_FALLBACKS) + ")";
        } else if (echoable(env.value)) {
            where = "the environment is \"" + env.value + "\" (from " + env.source + "), which is not a "
                    + "development name";
        } else {
            where = "the environment name from " + env.source + " is not a development name";
        }
        String retired = "";
        if (!StartEnv.trim(lookup.apply(Names.RETIRED_ENVIRONMENT_NAME)).isEmpty()) {
            retired = " " + Names.RETIRED_ENVIRONMENT_NAME + " is no longer read; rename it to "
                    + Names.ENV_ENVIRONMENT + ".";
        }
        return configError(Names.ENV_KEY + " is not set and " + where + ". Set " + Names.ENV_KEY
                + " to the project's server key, or for local development set " + Names.ENV_ENVIRONMENT
                + " to development or pass StartOptions.mode(Mode.LOCAL)." + retired);
    }

    static FireweaveException configError(String message) {
        return new FireweaveException(ErrorKind.Configuration, message);
    }
}
