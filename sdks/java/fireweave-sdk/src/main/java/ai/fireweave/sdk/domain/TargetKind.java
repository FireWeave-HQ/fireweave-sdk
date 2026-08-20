package ai.fireweave.sdk.domain;

/**
 * Target kind on {@code POST /v1/targets/register}
 * ({@code spec/remote-register-target.schema.json}).
 *
 * <p>Omitted from the wire when unset so the server can default to {@code user}.
 */
public enum TargetKind {
    USER("user"),
    DEVICE("device");

    private final String wireName;

    TargetKind(String wireName) {
        this.wireName = wireName;
    }

    /** Schema enum value ({@code user} / {@code device}). */
    public String wireName() {
        return wireName;
    }
}
