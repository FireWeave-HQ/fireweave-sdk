package ai.fireweave.sdk.start;

import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.function.Function;
import java.util.function.Supplier;

/**
 * {@link Fw#instanceKey()}'s derivation: a stable targeting key for reads where the server itself
 * is the subject (cron, workers, boot-time decisions). Request reads still pass the user's id
 * (node: src/start/instance.ts, go: fw/instance.go).
 *
 * <p>Sources, in order: {@code StartOptions.instanceId}, {@code FIREWEAVE_INSTANCE_ID}, then a hash
 * of the host name ({@code HOSTNAME}, else the operating system's), then a random id for the life
 * of the process. Nothing is written to disk: in a container the file would not outlive the
 * process.
 */
final class InstanceKeys {

    static final String SOURCE_OPTION = "option";
    static final String SOURCE_ENV = Names.ENV_INSTANCE_ID;
    static final String SOURCE_HOST = "host";
    static final String SOURCE_RANDOM = "random";

    private static final long FNV_OFFSET_BASIS = 0xcbf29ce484222325L;
    private static final long FNV_PRIME = 0x100000001b3L;

    private static final SecureRandom RANDOM = new SecureRandom();

    private InstanceKeys() {
    }

    /** A derived key and where it came from. */
    static final class Derived {
        final String value;
        final String source;

        Derived(String value, String source) {
            this.value = value;
            this.source = source;
        }
    }

    /**
     * FNV-1a 64-bit over the UTF-8 bytes, as 16 hex digits: the same function node and Go use, so
     * one host name gives one instance key in every SDK. Not a security hash.
     */
    static String fnv1a64(String text) {
        long hash = FNV_OFFSET_BASIS;
        for (byte b : text.getBytes(StandardCharsets.UTF_8)) {
            hash ^= (b & 0xff);
            hash *= FNV_PRIME;
        }
        String hex = Long.toHexString(hash);
        StringBuilder sb = new StringBuilder(16);
        for (int i = hex.length(); i < 16; i++) {
            sb.append('0');
        }
        return sb.append(hex).toString();
    }

    static String randomId() {
        byte[] bytes = new byte[16];
        RANDOM.nextBytes(bytes);
        StringBuilder sb = new StringBuilder(32);
        for (byte b : bytes) {
            sb.append(String.format("%02x", b & 0xff));
        }
        return sb.toString();
    }

    /**
     * Pure apart from the random fallback: the lookup and the operating-system host name are
     * injected.
     */
    static Derived derive(String option, Function<String, String> lookup, Supplier<String> osHostName) {
        String fromOption = StartEnv.trim(option);
        if (!fromOption.isEmpty()) {
            return new Derived(fromOption, SOURCE_OPTION);
        }
        String fromEnv = StartEnv.trim(lookup.apply(Names.ENV_INSTANCE_ID));
        if (!fromEnv.isEmpty()) {
            return new Derived(fromEnv, SOURCE_ENV);
        }
        String host = StartEnv.trim(lookup.apply(Names.ENV_HOSTNAME));
        if (host.isEmpty()) {
            host = StartEnv.trim(osHostName.get());
        }
        if (!host.isEmpty()) {
            return new Derived("inst_" + fnv1a64(host), SOURCE_HOST);
        }
        return new Derived("inst_" + randomId(), SOURCE_RANDOM);
    }
}
