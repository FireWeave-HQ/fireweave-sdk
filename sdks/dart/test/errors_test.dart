import 'package:fireweave/fireweave.dart';
import 'package:test/test.dart';

void main() {
  group('redactSecrets', () {
    test('redacts project key prefixes', () {
      expect(
        redactSecrets('key phc_SUPERSECRET0000 leaked'),
        'key [REDACTED] leaked',
      );
      expect(redactSecrets('phs_abc-DEF_123'), '[REDACTED]');
      expect(redactSecrets('phx_'), '[REDACTED]');
    });

    test('redacts bearer tokens', () {
      expect(
        redactSecrets('Authorization: Bearer abc.def.ghi'),
        'Authorization: [REDACTED]',
      );
    });

    test('redacts FW_PROJECT_API_KEY assignments', () {
      expect(redactSecrets('FW_PROJECT_API_KEY=supersecret'), '[REDACTED]');
      expect(redactSecrets('FW_PROJECT_API_KEY : supersecret'), '[REDACTED]');
      // No assignment marker -> not matched (mirrors the reference regex).
      expect(
        redactSecrets('FW_PROJECT_API_KEY is unset'),
        'FW_PROJECT_API_KEY is unset',
      );
    });

    test('collapses whitespace and trims', () {
      expect(redactSecrets('  a   b\n\tc  '), 'a b c');
    });

    test('leaves ordinary text alone', () {
      expect(redactSecrets('invalid configuration'), 'invalid configuration');
    });
  });

  group('ErrorKind / FireweaveError', () {
    test('taxonomy has fifteen members', () {
      expect(ErrorKind.values, hasLength(15));
      expect(ErrorKind.fromWireName('FlagNotFound'), ErrorKind.flagNotFound);
      expect(ErrorKind.fromWireName('Nope'), isNull);
    });

    test('targeting key missing overrides the error code', () {
      final err = FireweaveError.targetingKeyMissing();
      expect(err.openFeatureErrorCode, 'TARGETING_KEY_MISSING');
      expect(err.kind, ErrorKind.invalidContext);
      expect(err.message, 'targeting key missing');
    });

    test('configuration initFatal overrides the error code', () {
      expect(
        FireweaveError.configuration(
          'bad host',
          initFatal: true,
        ).openFeatureErrorCode,
        'PROVIDER_FATAL',
      );
      expect(
        FireweaveError.configuration(
          'bad host',
          initFatal: false,
        ).openFeatureErrorCode,
        'GENERAL',
      );
    });

    test('alreadyClosed maps to PROVIDER_NOT_READY', () {
      expect(
        FireweaveError(ErrorKind.alreadyClosed).openFeatureErrorCode,
        'PROVIDER_NOT_READY',
      );
    });

    test('retryable kinds are exactly the documented five', () {
      const retryable = <ErrorKind>{
        ErrorKind.notReady,
        ErrorKind.rateLimited,
        ErrorKind.timeout,
        ErrorKind.network,
        ErrorKind.backendUnavailable,
      };
      for (final kind in ErrorKind.values) {
        expect(
          kind.isRetryable,
          retryable.contains(kind),
          reason: kind.wireName,
        );
      }
    });

    test('messages are redacted at construction', () {
      final err = FireweaveError(
        ErrorKind.authentication,
        message: 'rejected key phc_LEAK',
      );
      expect(err.message, 'rejected key [REDACTED]');
      expect(FireweaveError(ErrorKind.flagNotFound).message, 'flag not found');
    });
  });
}
