package ai.fireweave.sdk.start;

import ai.fireweave.sdk.application.FireweaveClient;
import ai.fireweave.sdk.application.RegisterTargetOptions;
import ai.fireweave.sdk.application.RegisterTargetResult;
import ai.fireweave.sdk.domain.ErrorKind;
import ai.fireweave.sdk.domain.EvaluationContext;
import ai.fireweave.sdk.domain.FireweaveError;
import ai.fireweave.sdk.domain.FireweaveException;
import ai.fireweave.sdk.domain.JsonValue;
import ai.fireweave.sdk.domain.TargetKind;

import java.util.Map;
import java.util.function.Function;
import java.util.function.Supplier;

/**
 * The start profile's static facade: one line in {@code main}, then reads from anywhere (ADR-0011,
 * node's {@code fw}, Go's package {@code fw}). Safe to call from any thread, in any order.
 *
 * <pre>{@code
 * // FireweaveFlags.java: every control point the app reads, with its local value
 * public static final Flags FLAGS = Fw.defineFlags(Map.of(
 *         "new-checkout", Flag.local(true, "new checkout flow")));
 *
 * // main(), first thing after the app's own config loading
 * Fw.start(StartOptions.builder().flags(FireweaveFlags.FLAGS).build());
 *
 * // anywhere: the core client's nine read methods, unchanged
 * // @fireweave-controlpoint new-checkout
 * if (Fw.controlPoints().getBooleanValue("new-checkout", false,
 *         EvaluationContext.builder().targetingKey(user.id()).build())) { ... }
 * }</pre>
 *
 * <p>Reads never throw: if start failed they serve the caller's default, and the
 * {@code *Details} forms return an {@code ERROR} decision carrying the start error. A read before
 * any {@link #start} starts FireWeave from the environment alone, once, on that read; a later
 * start with a different configuration then throws. Call {@link #start} first in {@code main}.
 */
public final class Fw {

    private Fw() {
    }

    /**
     * Declares the app's control points and returns them, checking every key with the core's
     * control point key rule so a typo fails where it was made.
     *
     * @throws FireweaveException kind {@code Configuration}, for a null map, key or flag, or an
     *     invalid key
     */
    public static Flags defineFlags(Map<String, Flag> flags) {
        return Flags.of(flags);
    }

    /** {@link #start(StartOptions)} with everything read from the environment. */
    public static FireweaveClient start() {
        return start(StartOptions.defaults());
    }

    /**
     * Starts FireWeave for this process. Call it once, first thing in {@code main}, after the
     * app's own config loading.
     *
     * <p>Mode rule: {@code StartOptions.mode} wins ({@code LOCAL} ignores any key, with one
     * warning; {@code REMOTE} without a key is an error). Otherwise a key
     * ({@code StartOptions.key}, {@code FIREWEAVE_KEY}) means remote; no key and an environment
     * name ({@code StartOptions.environment}, {@code FIREWEAVE_ENV}, {@code APP_ENV}) of
     * development, dev, local or test means local; anything else, including no environment name
     * at all, is a {@code Configuration} error naming {@code FIREWEAVE_KEY}. A deploy that forgot
     * its key fails here instead of silently serving defaults.
     *
     * <p>Synchronous, with no network I/O. A second start with the same configuration is a
     * no-op; a different one throws and leaves the running client alone. No JVM shutdown hook is
     * registered.
     *
     * @return {@link #client()}, for dependency injection
     * @throws FireweaveException kind {@code Configuration}, naming the option or variable at
     *     fault and never a key
     */
    public static FireweaveClient start(StartOptions options) {
        StartSingleton.start(options);
        return StartSingleton.PERMANENT;
    }

    /**
     * The one {@link FireweaveClient} for this process: never null, and the same instance before
     * start, after it, and across {@link #shutdown()} and a later start. Use it for dependency
     * injection and anything the facade does not cover. Its reads behave like
     * {@link #controlPoints()}'s.
     *
     * <p>Shut down with {@link #shutdown()}, never {@code client().close()}, which would close
     * this permanent handle for the rest of the process.
     */
    public static FireweaveClient client() {
        return StartSingleton.PERMANENT;
    }

    /**
     * The core's control point namespace on {@link #client()}: the same nine read methods with the
     * same signatures ({@code evaluate}, {@code getBooleanValue}, {@code getStringValue},
     * {@code getNumberValue}, {@code getObjectValue} and the four {@code *Details}).
     */
    public static FireweaveClient.ControlPoints controlPoints() {
        return StartSingleton.PERMANENT.controlPoints();
    }

    /** {@link #identify(String, Map)} with no properties. */
    public static RegisterTargetResult identify(String targetingKey) {
        return identify(targetingKey, null);
    }

    /**
     * Registers durable targeting facts for a user at sign-in (the core's {@code registerTarget},
     * kind {@code user}). Never throws: a blank targeting key, a property value the core cannot
     * carry (anything but null, Boolean, Number, String, List, Map or {@link JsonValue}) and a
     * failed start come back as {@code ok=false} with the error.
     *
     * <p>In remote mode it is one blocking POST, retried once on a transient failure. Call it off
     * the request path when that matters.
     */
    public static RegisterTargetResult identify(String targetingKey, Map<String, ?> properties) {
        try {
            if (targetingKey == null || targetingKey.trim().isEmpty()) {
                return RegisterTargetResult.failure(FireweaveError.from(FireweaveException.targetingKeyMissing()));
            }
            RegisterTargetOptions.Builder options = RegisterTargetOptions.builder().kind(TargetKind.USER);
            if (properties != null) {
                for (Map.Entry<String, ?> e : properties.entrySet()) {
                    String name = e.getKey();
                    if (name == null) {
                        return invalid("identify: a property name is null.");
                    }
                    Object value = e.getValue();
                    EvaluationContext converted;
                    try {
                        converted = EvaluationContext.builder().attribute(name, value).build();
                    } catch (IllegalArgumentException ex) {
                        return invalid("identify: property \"" + name + "\" has an unsupported type ("
                                + value.getClass().getName() + ").");
                    }
                    if (converted.hadCyclicInput()) {
                        return invalid("identify: property \"" + name + "\" contains a circular reference.");
                    }
                    options.property(name, converted.attributes().get(name));
                }
            }
            return StartSingleton.PERMANENT.registerTarget(targetingKey, options.build());
        } catch (RuntimeException e) {
            return RegisterTargetResult.failure(
                    FireweaveError.of(ErrorKind.Internal, ErrorKind.Internal.defaultMessage()));
        }
    }

    private static RegisterTargetResult invalid(String message) {
        return RegisterTargetResult.failure(FireweaveError.of(ErrorKind.InvalidContext, message));
    }

    /**
     * A stable targeting key for reads where the server itself is the subject (cron, workers,
     * boot-time decisions): {@code StartOptions.instanceId}, else {@code FIREWEAVE_INSTANCE_ID},
     * else {@code inst_} plus an FNV-1a 64-bit hash of the host name (the same value node and Go
     * derive on that host), else a random id for the life of the process. Computed on first call
     * and cached; nothing is written to disk. Set {@code FIREWEAVE_INSTANCE_ID} when replicas
     * share a host name or a host name is not stable.
     */
    public static String instanceKey() {
        return StartSingleton.instanceKey();
    }

    /**
     * The singleton's state and what start decided: mode and why, channel, SDK version, host,
     * endpoint source, key source, environment, flag count and the start error. It never includes
     * the key, so it is safe to log.
     */
    public static StartStatus status() {
        return StartSingleton.status();
    }

    /**
     * Closes the started client. Afterwards reads serve their defaults ({@code AlreadyClosed}) and
     * nothing starts implicitly; a later {@link #start} begins fresh. Idempotent.
     */
    public static void shutdown() {
        StartSingleton.shutdown();
    }

    /**
     * This SDK's version as Maven built it (for example {@code 2.4.0} or {@code 2.4.0-staging.1}),
     * or {@code (devel)} when the build recorded none.
     */
    public static String sdkVersion() {
        return BuildInfo.version();
    }

    /**
     * The release channel of this SDK build: {@code STAGING} for a {@code -staging.N} version,
     * {@code PRODUCTION} for anything else. It picks the default endpoint.
     */
    public static SdkChannel sdkChannel() {
        return BuildInfo.channel();
    }

    /**
     * Test hook: shuts down and forgets the singleton so the next start begins as in a new
     * process. {@code env} and {@code hostName} stand in for the process environment and the host
     * name (null restores the real ones).
     */
    static void resetForTests(Function<String, String> env, Supplier<String> hostName) {
        StartSingleton.resetForTests(env, hostName);
    }
}
