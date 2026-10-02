/**
 * The FireWeave start profile: one-line setup layered over the unchanged core SDK
 * (docs/adr/0011-start-profile.md).
 *
 * <p>The core ({@code ai.fireweave.sdk.domain}, {@code .application}, {@code .infrastructure})
 * reads no environment and never infers a mode. This package is the documented exception: it
 * reads {@code FIREWEAVE_*} variables (through one class, {@code StartEnv}), chooses the mode by a
 * fail-closed rule, defaults the endpoint from this SDK build's release channel, and keeps one
 * client per process. It is built only on the core's public {@code application} and
 * {@code domain} types and {@code java.*}; nothing in the core imports it.
 *
 * <p>Entry point: {@link ai.fireweave.sdk.start.Fw}. It registers no JVM shutdown hook; call
 * {@link ai.fireweave.sdk.start.Fw#shutdown()} where the app stops (a servlet listener's
 * {@code contextDestroyed}, test teardown).
 */
package ai.fireweave.sdk.start;
