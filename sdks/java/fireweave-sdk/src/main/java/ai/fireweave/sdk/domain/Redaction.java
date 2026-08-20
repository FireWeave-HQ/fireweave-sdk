package ai.fireweave.sdk.domain;

import java.util.regex.Pattern;

/**
 * Secret redaction for error messages, logs and signal payloads.
 *
 * <p>Rules (canonical, from {@code contracts/errors.json} and
 * {@code spec/evaluation-context.schema.json}): API keys with prefixes {@code phc_}, {@code phs_},
 * {@code phx_}, bearer tokens, and {@code FW_PROJECT_API_KEY} values must never appear in
 * user-visible messages. Matching substrings are replaced with {@code [REDACTED]}.
 */
public final class Redaction {

    public static final String REDACTED = "[REDACTED]";

    // A key prefix followed by any run of plausible token characters.
    private static final Pattern KEY_PATTERN =
            Pattern.compile("(phc_|phs_|phx_)[A-Za-z0-9_\\-]*");
    private static final Pattern BEARER_PATTERN =
            Pattern.compile("Bearer\\s+[A-Za-z0-9._~+/\\-]+=*");
    private static final Pattern ENV_PATTERN =
            Pattern.compile("FW_PROJECT_API_KEY\\s*[=:]\\s*\\S+");

    private Redaction() {
    }

    /**
     * Returns the input with secret-shaped substrings replaced by {@code [REDACTED]}.
     * Null-safe (returns null for null input).
     */
    public static String sanitize(String message) {
        if (message == null) {
            return null;
        }
        String out = KEY_PATTERN.matcher(message).replaceAll(REDACTED);
        out = BEARER_PATTERN.matcher(out).replaceAll(REDACTED);
        out = ENV_PATTERN.matcher(out).replaceAll("FW_PROJECT_API_KEY=" + REDACTED);
        return out;
    }

    /** True if the message still contains a secret-shaped substring (used by tests/guards). */
    public static boolean containsSecret(String message) {
        if (message == null) {
            return false;
        }
        return KEY_PATTERN.matcher(message).find()
                || BEARER_PATTERN.matcher(message).find()
                || ENV_PATTERN.matcher(message).find();
    }
}
