package ai.fireweave.sdk.application;

import ai.fireweave.sdk.domain.FireweaveException;
import ai.fireweave.sdk.domain.Mode;
import ai.fireweave.sdk.domain.Validation;
import ai.fireweave.sdk.domain.Validation.Validated;
import ai.fireweave.sdk.infrastructure.adapters.FireweaveLocalAdapter;
import ai.fireweave.sdk.infrastructure.adapters.FireweaveRemoteAdapter;

/**
 * {@code Fireweave.init} — the single SDK entry point (spec/modes.md).
 *
 * <p>{@code mode} is required and never inferred: a missing or mistyped credential must fail
 * loudly at boot, not silently fall back to local evaluation — that failure mode looks like a
 * green boot and a feature that never ramps. This class's only job is to validate the
 * initialisation-time contract and select the matching adapter; nothing downstream branches on
 * mode again (spec/modes.md "Behaviour per mode" — both adapters implement the same
 * {@link BackendAdapter} port, so {@link FireweaveClient} / {@link FireweaveRuntime} stay
 * mode-blind).
 *
 * <p>Initialisation fails loudly (throws); reads on the returned client never do
 * (spec/control-points.md "initialise is the exception"). The validation itself lives in
 * {@link Validation#validateInitOptions}, which returns a {@code Validated} like every other
 * validator — this class is what converts a failed {@code Validated} into the throw
 * spec/modes.md requires.
 *
 * <p>This is the SANCTIONED composition root (mirroring node's {@code application/mode.ts} /
 * python's {@code application/mode.py}): the only class under {@code application/} that imports
 * concrete {@code infrastructure/adapters/*} types directly.
 */
public final class Fireweave {

    private Fireweave() {
    }

    /**
     * Build the adapter matching {@code options.mode()} and bring a {@link FireweaveClient} to
     * READY.
     *
     * <p>Throws {@link FireweaveException} (kind {@code Configuration}) for the
     * initialisation-validation table's rows (spec/modes.md):
     * <ul>
     *   <li>{@code mode} absent</li>
     *   <li>{@code mode == REMOTE} with {@code apiKey} or {@code apiUrl} missing/blank</li>
     *   <li>{@code apiUrl} fails the host allowlist</li>
     *   <li>{@code mode == LOCAL} with credentials supplied</li>
     * </ul>
     * The first, second and fourth rows are {@link Validation#validateInitOptions}'s job; the
     * third is validated downstream, when {@code FireweaveRuntime#initialize()} brings the
     * remote adapter up ({@code FireweaveRemoteAdapter}'s own SSRF allowlist check).
     */
    public static FireweaveClient init(InitOptions options) throws FireweaveException {
        Mode mode = options == null ? null : options.mode();
        String apiKey = options == null ? null : options.apiKey();
        String apiUrl = options == null ? null : options.apiUrl();

        Validated<Boolean> validated = Validation.validateInitOptions(mode, apiKey, apiUrl);
        if (!validated.isOk()) {
            throw validated.error();
        }
        return mode == Mode.LOCAL ? initLocal(options) : initRemote(options);
    }

    private static FireweaveClient initLocal(InitOptions options) throws FireweaveException {
        FireweaveLocalAdapter adapter = new FireweaveLocalAdapter(options.controlPoints(), options.log());
        FireweaveRuntime runtime = new FireweaveRuntime(FireweaveConfig.builder().build(), adapter);
        runtime.initialize();
        return new FireweaveClient(runtime);
    }

    private static FireweaveClient initRemote(InitOptions options) throws FireweaveException {
        FireweaveConfig.Builder configBuilder = FireweaveConfig.builder()
                .host(options.apiUrl())
                .projectApiKey(options.apiKey());
        if (options.allowedHosts() != null) {
            configBuilder.allowedHosts(options.allowedHosts());
        }
        FireweaveRuntime runtime = new FireweaveRuntime(configBuilder.build(), new FireweaveRemoteAdapter());
        runtime.initialize();
        return new FireweaveClient(runtime);
    }
}
