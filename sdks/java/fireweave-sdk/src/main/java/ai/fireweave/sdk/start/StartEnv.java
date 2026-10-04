package ai.fireweave.sdk.start;

import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;

/**
 * The ONLY class in this module that reads the process environment or the host name.
 *
 * <p>The core SDK reads no environment variables (spec/modes.md). The start profile is the
 * documented exception (docs/adr/0012-start-profile.md), and
 * {@code StartConfinementGuardTest} pins every environment read and host-name lookup to this
 * file.
 *
 * <p>Every value is trimmed, and "" means unset: unset, empty and whitespace-only are the same
 * to the start profile.
 */
final class StartEnv {

    /** How long the DNS-backed host-name lookup may take before the caller falls back. */
    private static final long HOST_LOOKUP_TIMEOUT_MS = 200;

    /** Linux's host name, readable without DNS. */
    private static final String PROC_HOSTNAME = "/proc/sys/kernel/hostname";

    private StartEnv() {
    }

    /** One variable from the running process's environment, trimmed; "" when unset. */
    static String processEnv(String name) {
        return trim(System.getenv(name));
    }

    /**
     * {@code StartOptions.env} when set (tests, apps that own their config source), else
     * {@code fallback}. Values are trimmed either way, and null means unset.
     */
    static Function<String, String> lookup(Function<String, String> injected,
                                           Function<String, String> fallback) {
        if (injected == null) {
            return fallback;
        }
        return name -> trim(injected.apply(name));
    }

    /**
     * The operating system's host name, or "" when it will not say in time.
     *
     * <p>Linux first reads {@code /proc/sys/kernel/hostname} (what {@code gethostname(2)}
     * returns, so it matches Go's {@code os.Hostname()} and node's {@code os.hostname()}). Other
     * systems ask {@code InetAddress.getLocalHost()}, which may need DNS: it runs on a daemon
     * thread and is abandoned after {@value #HOST_LOOKUP_TIMEOUT_MS} ms so a slow resolver never
     * stalls a read.
     */
    static String processHostName() {
        try {
            Path proc = Paths.get(PROC_HOSTNAME);
            if (Files.isReadable(proc)) {
                String name = trim(new String(Files.readAllBytes(proc), StandardCharsets.UTF_8));
                if (!name.isEmpty()) {
                    return name;
                }
            }
        } catch (Exception e) {
            // Unreadable /proc: fall through to the JDK lookup.
        }
        FutureTask<String> task = new FutureTask<>(() -> InetAddress.getLocalHost().getHostName());
        Thread thread = new Thread(task, "fireweave-hostname");
        thread.setDaemon(true);
        thread.start();
        try {
            return trim(task.get(HOST_LOOKUP_TIMEOUT_MS, TimeUnit.MILLISECONDS));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return "";
        } catch (Exception e) {
            task.cancel(true);
            return "";
        }
    }

    static String trim(String value) {
        return value == null ? "" : value.trim();
    }
}
