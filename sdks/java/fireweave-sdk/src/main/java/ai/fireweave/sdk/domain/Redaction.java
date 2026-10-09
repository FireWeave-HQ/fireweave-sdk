package ai.fireweave.sdk.domain;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Secret redaction for error messages, logs and signal payloads.
 *
 * <p>Implements {@code rules.redaction} in {@code contracts/errors.json} (start-profile spec
 * SP-26), applied in this order:
 *
 * <ol>
 *   <li><b>bearer tokens</b>: the token after {@code Bearer } becomes {@code [REDACTED]}; the word
 *       {@code Bearer} stays;</li>
 *   <li><b>URL userinfo</b>: in {@code scheme://userinfo@host}, the userinfo becomes
 *       {@code [REDACTED]};</li>
 *   <li><b>named assignments</b>: {@code FIREWEAVE_KEY}, {@code FIREWEAVE_BROWSER_KEY} or
 *       {@code FW_PROJECT_API_KEY} followed by {@code =} or {@code :} (spaces and one quote
 *       allowed): the value, up to whitespace, a quote, a comma or a semicolon, becomes
 *       {@code [REDACTED]}; the name, separator and quotes stay;</li>
 *   <li><b>key-shaped values</b>: a known key prefix followed by one or more
 *       {@code [A-Za-z0-9_-]} becomes {@code [REDACTED]}. A prefix followed by anything else (the
 *       ellipsis in {@code project-api-key_…}) is prose and stays.</li>
 * </ol>
 *
 * <p>A variable NAME is never redacted on its own, so "set FIREWEAVE_KEY" stays readable.
 * {@code RedactionTest} runs every vector in the contract through {@link #sanitize}.
 */
public final class Redaction {

    public static final String REDACTED = "[REDACTED]";

    private static final Pattern BEARER =
            Pattern.compile("(Bearer\\s+)[A-Za-z0-9._~+/=-]+");
    private static final Pattern URL_USERINFO =
            Pattern.compile("([A-Za-z][A-Za-z0-9+.-]*://)[^/?#@\\s]+@");
    private static final Pattern ASSIGNMENT = Pattern.compile(
            "(FIREWEAVE_KEY|FIREWEAVE_BROWSER_KEY|FW_PROJECT_API_KEY)(\\s*[=:]\\s*)([\"']?)[^\\s\"',;]+");
    private static final Pattern KEY_VALUE = Pattern.compile(
            "(?:project-api-key_|fw_public_|fw_ingest_pub_|fw_org_|cli_at_|phc_|phx_|phs_)[A-Za-z0-9_-]+");

    private static final String PLACEHOLDER = Matcher.quoteReplacement(REDACTED);

    private Redaction() {
    }

    /**
     * Returns the input with secret-shaped substrings replaced by {@code [REDACTED]}.
     * Null-safe (returns null for null input). Idempotent.
     */
    public static String sanitize(String message) {
        if (message == null) {
            return null;
        }
        String out = BEARER.matcher(message).replaceAll("$1" + PLACEHOLDER);
        out = URL_USERINFO.matcher(out).replaceAll("$1" + PLACEHOLDER + "@");
        out = ASSIGNMENT.matcher(out).replaceAll("$1$2$3" + PLACEHOLDER);
        out = KEY_VALUE.matcher(out).replaceAll(PLACEHOLDER);
        return out;
    }

    /** True if {@link #sanitize} would change the message (used by tests/guards). */
    public static boolean containsSecret(String message) {
        if (message == null) {
            return false;
        }
        return !message.equals(sanitize(message));
    }
}
