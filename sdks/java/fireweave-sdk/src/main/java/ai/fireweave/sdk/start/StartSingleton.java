package ai.fireweave.sdk.start;

import ai.fireweave.sdk.application.BackendAdapter;
import ai.fireweave.sdk.application.EvaluationRequest;
import ai.fireweave.sdk.application.Fireweave;
import ai.fireweave.sdk.application.FireweaveClient;
import ai.fireweave.sdk.application.FireweaveConfig;
import ai.fireweave.sdk.application.FireweaveRuntime;
import ai.fireweave.sdk.application.InitOptions;
import ai.fireweave.sdk.application.RegisterTargetOptions;
import ai.fireweave.sdk.application.RegisterTargetResult;
import ai.fireweave.sdk.domain.Decision;
import ai.fireweave.sdk.domain.ErrorKind;
import ai.fireweave.sdk.domain.EvaluationContext;
import ai.fireweave.sdk.domain.FireweaveError;
import ai.fireweave.sdk.domain.FireweaveException;
import ai.fireweave.sdk.domain.Mode;
import ai.fireweave.sdk.domain.Redaction;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.EnumSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Consumer;
import java.util.function.Function;
import java.util.function.Supplier;

/**
 * {@link Fw#start} and the process-wide singleton behind {@link Fw}'s static methods (node:
 * src/start/state.ts, go: fw/state.go).
 *
 * <p>The SDK keeps ONE permanent {@link FireweaveClient} for the life of the class loader, built
 * with no environment reads and no I/O. Its runtime sits on a forwarding {@link BackendAdapter},
 * so a reference captured before start (a static field, a Spring bean) keeps working after start,
 * across {@link Fw#shutdown()} and a later start. Start resolves the config, builds the real
 * client with the unchanged core {@code Fireweave.init} (so the core validation table still
 * runs), and points the forwarder at it.
 *
 * <p>A read before any start starts FireWeave from the environment alone, once, synchronously on
 * that read. {@code Fireweave.init} does no network I/O, so this never blocks on the network.
 *
 * <p>Transitions are serialized on {@link #LOCK}; a read of a READY singleton takes no lock.
 * Lines are logged after the lock is released, so a log handler can never deadlock a read.
 */
final class StartSingleton {

    private StartSingleton() {
    }

    private static final Object LOCK = new Object();

    private static final System.Logger LOGGER = System.getLogger("ai.fireweave");

    /** A started client and the decision that built it. Immutable. */
    private static final class Run {
        final FireweaveClient client;
        final StartResolver.Resolved resolved;

        Run(FireweaveClient client, StartResolver.Resolved resolved) {
            this.client = client;
            this.resolved = resolved;
        }
    }

    /** One line to log, with its level. */
    private static final class Line {
        final System.Logger.Level level;
        final String message;

        Line(System.Logger.Level level, String message) {
            this.level = level;
            this.message = message;
        }
    }

    // ---------------------------------------------------------------- state (guarded by LOCK)

    private static volatile StartState state = StartState.UNSTARTED;
    /** The running client; non-null exactly when state is READY. Read lock-free by reads. */
    private static volatile Run run;
    /** The last decision that started, kept across shutdown for status(). */
    private static StartResolver.Resolved resolved;
    private static String signature;
    /** The running client came from an implicit start. */
    private static boolean implicit;
    /** Reads do not start implicitly again. */
    private static boolean implicitTried;
    private static FireweaveException error;
    /** The lookup the running client started with, for instanceKey(). */
    private static Function<String, String> lookup;

    private static String instanceOption;
    private static String instanceKey;

    /** The app's log sink, set by the first explicit start that begins. */
    private static volatile Consumer<String> sink;
    private static final Set<String> WARNED = ConcurrentHashMap.newKeySet();

    /**
     * Remote failures that mean "the key was refused, throttled or fw-server is unreachable"
     * (SP-27): each is logged once for the life of the process and reported in status.
     */
    static final Set<ErrorKind> REMOTE_FAILURES = Collections.unmodifiableSet(EnumSet.of(
            ErrorKind.Authentication, ErrorKind.Authorization, ErrorKind.RateLimited,
            ErrorKind.Network, ErrorKind.Timeout, ErrorKind.BackendUnavailable));
    /** The {@link #REMOTE_FAILURES} kinds already logged; kept across shutdown and restart. */
    private static final Set<ErrorKind> REMOTE_WARNED = ConcurrentHashMap.newKeySet();
    /** The latest {@link #REMOTE_FAILURES} kind the running client saw; null if none. */
    private static volatile ErrorKind lastErrorKind;

    // Test seams (resetForTests): where an implicit start and instanceKey() read from.
    private static volatile Function<String, String> processEnv = StartEnv::processEnv;
    private static volatile Supplier<String> processHostName = StartEnv::processHostName;

    /** The one client handed out for the life of the class loader. */
    static final FireweaveClient PERMANENT = newPermanentClient();

    private static FireweaveClient newPermanentClient() {
        FireweaveRuntime runtime = new FireweaveRuntime(FireweaveConfig.builder().build(), new Forwarder());
        // A config with no host and a forwarder whose initialize does nothing cannot fail.
        runtime.initialize();
        return new FireweaveClient(runtime);
    }

    // ---------------------------------------------------------------- start

    static void start(StartOptions options) {
        List<Line> lines = new ArrayList<>();
        FireweaveException failure;
        synchronized (LOCK) {
            failure = startLocked(options == null ? StartOptions.defaults() : options, false, lines);
        }
        emit(lines);
        if (failure != null) {
            throw failure;
        }
    }

    /** Start's body. Returns the error to report, or null. */
    private static FireweaveException startLocked(StartOptions opts, boolean isImplicit, List<Line> lines) {
        if (state == StartState.FAILED || state == StartState.SHUTDOWN) {
            freshRunLocked();
        }

        Function<String, String> lk = StartEnv.lookup(opts.env(), processEnv);
        StartResolver.Resolved r;
        try {
            r = StartResolver.resolve(opts, lk, BuildInfo.version(), BuildInfo.channel());
        } catch (FireweaveException e) {
            return failResolveLocked(e, isImplicit, lines);
        } catch (RuntimeException e) {
            // Only a throwing StartOptions.env lookup gets here.
            return failResolveLocked(StartResolver.configError("StartOptions.env threw "
                    + e.getClass().getName() + " while the start profile read its variables."), isImplicit, lines);
        }
        String sig = signatureOf(r, opts.instanceId());

        if (state == StartState.READY) {
            List<String> diff = differs(signature, sig);
            if (diff.isEmpty()) {
                return null;
            }
            String fields = String.join(", ", diff);
            if (implicit) {
                return StartResolver.configError("A control point was read before Fw.start ran, so FireWeave "
                        + "started from the environment alone; this start differs in " + fields
                        + ". Call Fw.start first in main, before anything reads a control point.");
            }
            return StartResolver.configError("Fw.start was already called with a different configuration ("
                    + fields + "). Call Fw.start once, from main.");
        }

        String id = StartEnv.trim(opts.instanceId());
        if (!id.isEmpty() && instanceKey != null && !instanceKey.equals(id)) {
            return StartResolver.configError("StartOptions.instanceId differs from the Fw.instanceKey() already "
                    + "handed out. Pass instanceId on the first Fw.start.");
        }

        // Only a start that actually begins sets the sink: an identical second start is a no-op
        // and a conflicting one fails, and neither may swap it.
        if (!isImplicit && opts.log() != null) {
            sink = opts.log();
        }

        FireweaveClient client;
        try {
            client = Fireweave.init(initOptions(r));
        } catch (FireweaveException e) {
            state = StartState.FAILED;
            error = e;
            implicitTried = true;
            warnOnce(lines, "[fireweave] start failed: " + e.getMessage() + ". Reads serve their defaults.");
            return e;
        } catch (RuntimeException e) {
            FireweaveException wrapped = new FireweaveException(ErrorKind.Internal,
                    ErrorKind.Internal.defaultMessage(), e);
            state = StartState.FAILED;
            error = wrapped;
            implicitTried = true;
            warnOnce(lines, "[fireweave] start failed: " + wrapped.getMessage() + ". Reads serve their defaults.");
            return wrapped;
        }

        resolved = r;
        signature = sig;
        implicit = isImplicit;
        implicitTried = true;
        error = null;
        lookup = lk;
        if (!id.isEmpty()) {
            instanceOption = id;
        }
        run = new Run(client, r);
        state = StartState.READY;
        for (String w : r.warnings) {
            warnOnce(lines, w);
        }
        if (r.mode == Mode.LOCAL) {
            lines.add(new Line(System.Logger.Level.INFO, localLine(r)));
        }
        return null;
    }

    private static FireweaveException failResolveLocked(FireweaveException e, boolean isImplicit, List<Line> lines) {
        if (state == StartState.READY) {
            // A bad second start never takes down the running client.
            return e;
        }
        state = StartState.FAILED;
        error = e;
        implicitTried = true;
        if (isImplicit) {
            warnOnce(lines, "[fireweave] " + e.getMessage() + " (FireWeave was not started; reads serve their defaults.)");
        }
        return e;
    }

    /** Forgets a failed or shut-down start, keeping the warned set, the sink and the instance key. */
    private static void freshRunLocked() {
        state = StartState.UNSTARTED;
        run = null;
        resolved = null;
        signature = null;
        implicit = false;
        implicitTried = false;
        error = null;
        lookup = null;
        lastErrorKind = null;
        // The instance key outlives a run: it identifies the process, so a key handed out before
        // a failed or shut-down start stays the same after it.
    }

    private static InitOptions initOptions(StartResolver.Resolved r) {
        if (r.mode == Mode.LOCAL) {
            return InitOptions.builder(Mode.LOCAL)
                    .controlPoints(r.flags.localValues())
                    .log(StartSingleton::info)
                    .build();
        }
        InitOptions.Builder b = InitOptions.builder(Mode.REMOTE).apiKey(r.key).apiUrl(r.url);
        if (r.allowedHosts != null) {
            b.allowedHosts(new java.util.LinkedHashSet<>(r.allowedHosts));
        }
        return b.build();
    }

    // ---------------------------------------------------------------- idempotency

    /**
     * What makes two starts "the same". Flags count in local mode only: remote ignores them, so
     * an implicit env-only start followed by Fw.start(flags) under a key is not a conflict.
     */
    static String signatureOf(StartResolver.Resolved r, String instanceId) {
        List<String> parts = new ArrayList<>();
        parts.add(String.valueOf(r.mode));
        parts.add(Objects.toString(r.url, ""));
        parts.add(r.key == null ? "" : sha256(r.key));
        parts.add(r.allowedHosts == null ? "" : String.join(",", r.allowedHosts));
        parts.add(StartEnv.trim(instanceId));
        parts.add(r.mode == Mode.LOCAL ? r.flags.signature() : "");
        StringBuilder sb = new StringBuilder();
        for (String p : parts) {
            sb.append(p.length()).append(':').append(p).append('|');
        }
        return sb.toString();
    }

    private static final String[] SIGNATURE_FIELDS = {"mode", "url", "key", "allowed hosts", "instance id", "flags"};

    /** Names the fields that differ, never their values. */
    private static List<String> differs(String a, String b) {
        List<String> pa = splitSignature(a);
        List<String> pb = splitSignature(b);
        List<String> out = new ArrayList<>();
        for (int i = 0; i < SIGNATURE_FIELDS.length; i++) {
            if (!pa.get(i).equals(pb.get(i))) {
                out.add(SIGNATURE_FIELDS[i]);
            }
        }
        return out;
    }

    private static List<String> splitSignature(String sig) {
        List<String> out = new ArrayList<>();
        int i = 0;
        while (i < sig.length()) {
            int colon = sig.indexOf(':', i);
            int len = Integer.parseInt(sig.substring(i, colon));
            out.add(sig.substring(colon + 1, colon + 1 + len));
            i = colon + 1 + len + 1;
        }
        return out;
    }

    private static String sha256(String text) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte d : digest) {
                sb.append(String.format("%02x", d & 0xff));
            }
            return sb.toString();
        } catch (NoSuchAlgorithmException e) {
            // Every Java platform must provide SHA-256 (MessageDigest Javadoc).
            throw new IllegalStateException(e);
        }
    }

    // ---------------------------------------------------------------- reads

    /** The client for one read or registration, or the error that read reports instead. */
    private static final class Acquired {
        final FireweaveClient client;
        final Mode mode;
        final FireweaveException error;

        Acquired(FireweaveClient client, Mode mode, FireweaveException error) {
            this.client = client;
            this.mode = mode;
            this.error = error;
        }
    }

    /**
     * Returns the running client, starting FireWeave from the environment if nothing has started
     * it yet. {@code flagKey} is null for a registration.
     */
    private static Acquired acquire(String flagKey) {
        Run current = run;
        if (current != null) {
            if (current.resolved.mode == Mode.LOCAL) {
                List<Line> lines = new ArrayList<>(1);
                noteLocalKey(current.resolved, flagKey, lines);
                emit(lines);
            }
            return new Acquired(current.client, current.resolved.mode, null);
        }
        List<Line> lines = new ArrayList<>();
        Acquired out;
        synchronized (LOCK) {
            if (state == StartState.UNSTARTED && !implicitTried) {
                startLocked(StartOptions.defaults(), true, lines);
            }
            Run r = run;
            if (state == StartState.READY && r != null) {
                noteLocalKey(r.resolved, flagKey, lines);
                out = new Acquired(r.client, r.resolved.mode, null);
            } else if (state == StartState.SHUTDOWN) {
                out = new Acquired(null, null, new FireweaveException(ErrorKind.AlreadyClosed));
            } else {
                out = new Acquired(null, null, error != null ? error
                        : new FireweaveException(ErrorKind.NotReady, "FireWeave was not started."));
            }
        }
        emit(lines);
        return out;
    }

    /** Local mode: a key missing from the flags gets its default, with one warning. */
    private static void noteLocalKey(StartResolver.Resolved r, String flagKey, List<Line> lines) {
        if (flagKey == null || r.mode != Mode.LOCAL || r.flags.contains(flagKey)) {
            return;
        }
        warnOnce(lines, "[fireweave:local] \"" + flagKey + "\" is not in your flags (" + Names.FLAGS_FILE
                + "), so it gets its default. Add it there to try it locally.");
    }

    /**
     * The permanent client's adapter: it hands each call to the client the latest start built.
     * Reads that cannot reach one degrade to the caller's default with the start error, exactly
     * as a core read degrades (the permanent runtime turns the thrown error into an ERROR
     * decision).
     */
    private static final class Forwarder implements BackendAdapter {

        @Override
        public String name() {
            return "other";
        }

        @Override
        public void initialize(FireweaveConfig config) {
            // Nothing to connect: the real client is built by start.
        }

        @Override
        public Decision evaluate(EvaluationRequest request) {
            Acquired a = acquire(request.flagKey());
            if (a.error != null) {
                throw a.error;
            }
            // The context is already merged and validated by the permanent runtime; the real
            // runtime validates it again (idempotent) and applies its own lifecycle gate.
            Decision d = a.client.runtime().evaluate(request.flagKey(), request.type(), request.defaultValue(),
                    EvaluationContext.empty(), request.context(), request.options());
            observeRemote(d.error());
            return d;
        }

        @Override
        public RegisterTargetResult registerTarget(String targetingKey, RegisterTargetOptions options) {
            Acquired a = acquire(null);
            if (a.error != null) {
                return RegisterTargetResult.failure(FireweaveError.from(a.error));
            }
            RegisterTargetResult result = a.client.registerTarget(targetingKey, options);
            if (!result.ok()) {
                observeRemote(result.error());
            }
            return result;
        }

        @Override
        public void shutdown() {
            // Fw.shutdown closes the started client, never the permanent one.
        }
    }

    // ---------------------------------------------------------------- refused key, throttling, unreachable

    /**
     * Notes a failure the started client got back from fw-server (SP-27): a refused key, rate
     * limiting or an unreachable endpoint is logged once per kind for the life of the process
     * and becomes {@link StartStatus#lastErrorKind()}, so a revoked key does not look like a
     * rollout at 0%. Observes only: the read has already resolved to its default.
     */
    private static void observeRemote(FireweaveError err) {
        if (err == null || !REMOTE_FAILURES.contains(err.kind())) {
            return;
        }
        ErrorKind kind = err.kind();
        List<Line> lines = new ArrayList<>(1);
        synchronized (LOCK) {
            lastErrorKind = kind;
            if (REMOTE_WARNED.add(kind)) {
                lines.add(new Line(System.Logger.Level.WARNING, Redaction.sanitize(remoteLine(kind, resolved))));
            }
        }
        emit(lines);
    }

    /** The one line for a remote failure kind: names the key's source or the host, never the key. */
    static String remoteLine(ErrorKind kind, StartResolver.Resolved r) {
        String source = r == null || r.keySource == null || "none".equals(r.keySource) ? Names.ENV_KEY : r.keySource;
        String host = r == null ? null : hostOf(r.url);
        String server = host == null ? "fw-server" : "fw-server at " + host;
        String endpoint = r == null || r.urlSource == null ? Names.ENV_URL : r.urlSource;
        switch (kind) {
            case Authentication:
                return "[fireweave] " + server + " rejected the key from " + source + " (401, Authentication), "
                        + "so every read serves its default. Check that " + source + " holds this project's key "
                        + "(project-api-key_\u2026) and that it has not been revoked.";
            case Authorization:
                return "[fireweave] " + server + " refused the key from " + source + " (403, Authorization), "
                        + "so every read serves its default. Check that the key belongs to this project.";
            case RateLimited:
                return "[fireweave] " + server + " is rate-limiting the key from " + source + " (429, RateLimited); "
                        + "reads serve their defaults until it recovers.";
            default:
                return "[fireweave] Could not reach " + server + " (" + kind.name() + "); reads serve their "
                        + "defaults until it is reachable. The endpoint comes from " + endpoint + ".";
        }
    }

    /** The host name of an endpoint URL, normalized; null when there is none. */
    private static String hostOf(String url) {
        if (url == null) {
            return null;
        }
        try {
            return StartResolver.normalizeHost(new URI(url).getHost());
        } catch (Exception e) {
            return null;
        }
    }

    /** The probe {@link Fw#verify()} evaluates; fw-server answering "not found" proves the key. */
    static final String VERIFY_KEY = "fireweave-verify";

    static VerifyResult verify() {
        try {
            Acquired a = acquire(null);
            if (a.error != null) {
                return VerifyResult.failure(a.error.kind(), a.error.getMessage());
            }
            if (a.mode != Mode.REMOTE) {
                return VerifyResult.failure(ErrorKind.Configuration, "FireWeave is in local mode, so there is no "
                        + "key to verify and nothing is sent to fw-server. Set " + Names.ENV_KEY + " to verify a key.");
            }
            Decision d = PERMANENT.controlPoints().getBooleanDetails(VERIFY_KEY, false,
                    EvaluationContext.builder().targetingKey(VERIFY_KEY).build());
            FireweaveError e = d.error();
            if (e == null || e.kind() == ErrorKind.FlagNotFound) {
                // fw-server accepted the key; the probe key simply is not a control point.
                return VerifyResult.success();
            }
            return VerifyResult.failure(e.kind(), e.message());
        } catch (RuntimeException e) {
            return VerifyResult.failure(ErrorKind.Internal, ErrorKind.Internal.defaultMessage());
        }
    }

    // ---------------------------------------------------------------- shutdown, instance key, status

    /**
     * Closes the started client. Afterwards reads serve their defaults (AlreadyClosed) and nothing
     * starts implicitly; a later start begins fresh.
     */
    static void shutdown() {
        Run current;
        synchronized (LOCK) {
            current = run;
            run = null;
            state = StartState.SHUTDOWN;
            implicitTried = true;
        }
        if (current != null) {
            current.client.close();
        }
    }

    static String instanceKey() {
        synchronized (LOCK) {
            if (instanceKey == null) {
                Function<String, String> lk = lookup != null ? lookup : processEnv;
                instanceKey = InstanceKeys.derive(instanceOption, lk, processHostName).value;
            }
            return instanceKey;
        }
    }

    static StartStatus status() {
        synchronized (LOCK) {
            StartResolver.Resolved r = resolved;
            String err = error == null ? null : error.getMessage();
            if (r == null) {
                return new StartStatus(state, null, null, BuildInfo.channel(), BuildInfo.version(),
                        null, null, null, null, 0, err, lastErrorKind);
            }
            String host = hostOf(r.url);
            String endpointSource = r.url == null ? null : r.urlSource;
            return new StartStatus(state, r.mode, r.modeSource, r.channel, r.sdkVersion, host, endpointSource,
                    r.keySource, r.environment, r.flags.size(), err, lastErrorKind);
        }
    }

    // ---------------------------------------------------------------- logging

    private static String localLine(StartResolver.Resolved r) {
        String why = "StartOptions.mode(LOCAL)";
        if (StartResolver.MODE_SOURCE_ENVIRONMENT.equals(r.modeSource)) {
            why = "no " + Names.ENV_KEY + "; environment \"" + r.environment + "\" from " + r.environmentSource;
        }
        int n = r.flags.size();
        return "[fireweave:local] Local mode (" + why + "). Serving " + n + (n == 1 ? " flag" : " flags")
                + " from your flags; nothing is sent to fw-server.";
    }

    /** Appends {@code line} unless this process already logged it. */
    private static void warnOnce(List<Line> lines, String line) {
        if (WARNED.add(line)) {
            lines.add(new Line(System.Logger.Level.WARNING, line));
        }
    }

    /** Routes the core local adapter's {@code [fireweave:local]} trace through the current sink. */
    private static void info(String line) {
        emit(Collections.singletonList(new Line(System.Logger.Level.INFO, line)));
    }

    private static void emit(List<Line> lines) {
        if (lines.isEmpty()) {
            return;
        }
        Consumer<String> s = sink;
        for (Line l : lines) {
            try {
                if (s != null) {
                    s.accept(l.message);
                } else {
                    LOGGER.log(l.level, l.message);
                }
            } catch (RuntimeException e) {
                // A failing log sink must never fail a read or a start.
            }
        }
    }

    // ---------------------------------------------------------------- tests

    /**
     * Shuts down and forgets the singleton, warnings, instance key and sink included, so the next
     * start begins as in a new process. The permanent client is kept: it holds no state of its
     * own. {@code env} and {@code hostName} replace the process environment and host name for
     * implicit starts and {@link Fw#instanceKey()} (null restores the real ones).
     */
    static void resetForTests(Function<String, String> env, Supplier<String> hostName) {
        Run current;
        synchronized (LOCK) {
            current = run;
            freshRunLocked();
            instanceOption = null;
            instanceKey = null;
            sink = null;
            WARNED.clear();
            REMOTE_WARNED.clear();
            processEnv = env == null ? StartEnv::processEnv : StartEnv.lookup(env, null);
            processHostName = hostName == null ? StartEnv::processHostName : hostName;
        }
        if (current != null) {
            current.client.close();
        }
    }
}
