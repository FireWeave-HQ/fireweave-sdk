package ai.fireweave.sdk;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Collectors;
import java.util.stream.IntStream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ConcurrencyTest {

    @Test
    @Timeout(30)
    void concurrentEvaluationsAreConsistent() throws Exception {
        StubAdapter adapter = new StubAdapter();
        FireweaveRuntime rt = new FireweaveRuntime(FireweaveConfig.builder().build(), adapter);
        rt.initialize();

        int threads = 16;
        int perThread = 500;
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        try {
            CountDownLatch start = new CountDownLatch(1);
            List<Future<Integer>> futures = IntStream.range(0, threads)
                    .mapToObj(t -> pool.submit((Callable<Integer>) () -> {
                        start.await();
                        int ok = 0;
                        for (int i = 0; i < perThread; i++) {
                            Decision d = rt.evaluate("f", FlagType.BOOLEAN, JsonValue.of(false),
                                    null, EvaluationContext.builder().targetingKey("u" + i).build(), null);
                            if (d.error() == null && d.value().asBoolean()) {
                                ok++;
                            }
                        }
                        return ok;
                    })).collect(Collectors.toList());
            start.countDown();
            int total = 0;
            for (Future<Integer> f : futures) {
                total += f.get(20, TimeUnit.SECONDS);
            }
            assertEquals(threads * perThread, total);
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    @Timeout(30)
    void shutdownDuringEvaluationNeverThrows() throws Exception {
        StubAdapter adapter = new StubAdapter();
        FireweaveRuntime rt = new FireweaveRuntime(FireweaveConfig.builder().build(), adapter);
        rt.initialize();

        AtomicInteger successes = new AtomicInteger();
        AtomicInteger closedDefaults = new AtomicInteger();
        AtomicInteger unexpected = new AtomicInteger();

        int threads = 8;
        ExecutorService pool = Executors.newFixedThreadPool(threads + 1);
        try {
            CountDownLatch start = new CountDownLatch(1);
            CountDownLatch firstBatchDone = new CountDownLatch(threads);
            List<Future<?>> futures = IntStream.range(0, threads)
                    .mapToObj(t -> pool.submit(() -> {
                        try {
                            start.await();
                            for (int i = 0; i < 2000; i++) {
                                Decision d = rt.evaluate("f", FlagType.BOOLEAN, JsonValue.of(false),
                                        null, null, null);
                                if (d.error() == null) {
                                    successes.incrementAndGet();
                                } else if (d.error().kind() == ErrorKind.AlreadyClosed) {
                                    closedDefaults.incrementAndGet();
                                } else {
                                    unexpected.incrementAndGet();
                                }
                                if (i == 100) {
                                    firstBatchDone.countDown();
                                }
                            }
                        } catch (Throwable e) {
                            unexpected.incrementAndGet();
                        }
                        return null;
                    })).collect(Collectors.toList());
            Future<?> closer = pool.submit(() -> {
                start.await();
                firstBatchDone.await();
                rt.shutdown();
                return null;
            });
            start.countDown();
            for (Future<?> f : futures) {
                f.get(20, TimeUnit.SECONDS);
            }
            closer.get(20, TimeUnit.SECONDS);

            assertEquals(0, unexpected.get(), "no exceptions or unexpected error kinds");
            assertTrue(successes.get() > 0, "some evaluations succeeded before shutdown");
            assertTrue(closedDefaults.get() > 0, "some evaluations observed AlreadyClosed defaults");
            assertEquals(1, adapter.shutdownCalls);
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    @Timeout(30)
    void concurrentExposureRecordingKeepsDedupInvariant() throws Exception {
        StubAdapter adapter = new StubAdapter();
        FireweaveRuntime rt = new FireweaveRuntime(FireweaveConfig.builder().build(), adapter);
        rt.initialize();
        FireweaveClient client = new FireweaveClient(rt);

        int threads = 8;
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        try {
            CountDownLatch start = new CountDownLatch(1);
            List<Future<?>> futures = IntStream.range(0, threads)
                    .mapToObj(t -> pool.submit(() -> {
                        start.await();
                        for (int i = 0; i < 200; i++) {
                            client.exposures().record(new Exposure("org", "flag-" + (i % 10),
                                    "on", JsonValue.of(true), null));
                        }
                        return null;
                    })).collect(Collectors.toList());
            start.countDown();
            for (Future<?> f : futures) {
                f.get(20, TimeUnit.SECONDS);
            }
            assertEquals(10, client.exposures().queuedCount(), "deduped to distinct flags");
        } finally {
            pool.shutdownNow();
        }
    }
}
