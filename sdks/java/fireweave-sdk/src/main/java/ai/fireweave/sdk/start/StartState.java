package ai.fireweave.sdk.start;

/** Where the start profile's process-wide client is in its life ({@link Fw#status()}). */
public enum StartState {
    /** Nothing has started FireWeave yet. */
    UNSTARTED,
    /** A start succeeded; reads go to the client it built. */
    READY,
    /** A start failed; reads serve their defaults with the start error. */
    FAILED,
    /** {@link Fw#shutdown()} ran; reads serve their defaults until the next start. */
    SHUTDOWN
}
