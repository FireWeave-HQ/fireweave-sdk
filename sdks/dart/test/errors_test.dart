import 'package:fireweave/fireweave.dart';
import 'package:test/test.dart';

void main() {
  group('redactSecrets', () {
    // Every vector of contracts/errors.json rules.redaction is checked by
    // redaction_contract_test.dart; these pin the edges around it.
    test('redacts project key prefixes', () {
      expect(
        redactSecrets('key phc_SUPERSECRET0000 leaked'),
        'key [REDACTED] leaked',
      );
      expect(redactSecrets('phs_abc-DEF_123'), '[REDACTED]');
    });

    test('a bare prefix with no value is prose', () {
      expect(redactSecrets('keys start with phx_'), 'keys start with phx_');
    });

    test('redacts the bearer token and keeps the word', () {
      expect(
        redactSecrets('Authorization: Bearer abc.def.ghi'),
        'Authorization: Bearer [REDACTED]',
      );
    });

    test('redacts assignment values and keeps the name', () {
      expect(
        redactSecrets('FW_PROJECT_API_KEY=supersecret'),
        'FW_PROJECT_API_KEY=[REDACTED]',
      );
      expect(
        redactSecrets('FW_PROJECT_API_KEY : supersecret'),
        'FW_PROJECT_API_KEY : [REDACTED]',
      );
      expect(
        redactSecrets("FIREWEAVE_KEY='s3cret', next"),
        "FIREWEAVE_KEY='[REDACTED]', next",
      );
      expect(
        redactSecrets('FW_PROJECT_API_KEY is unset'),
        'FW_PROJECT_API_KEY is unset',
      );
    });

    test('changes nothing but the secrets', () {
      expect(redactSecrets('  a   b\n\tc  '), '  a   b\n\tc  ');
      expect(redactSecrets('invalid configuration'), 'invalid configuration');
    });
  });

  group('ErrorKind / FireweaveError', () {
    test('taxonomy has fifteen members', () {
      expect(ErrorKind.values, hasLength(15));
      expect(
        ErrorKind.fromWireName('ControlPointNotFound'),
        ErrorKind.controlPointNotFound,
      );
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
      expect(
        FireweaveError(ErrorKind.controlPointNotFound).message,
        'flag not found',
      );
    });

    test('messages collapse whitespace and trim', () {
      expect(
        FireweaveError(ErrorKind.internal, message: '  a   b\n\tc  ').message,
        'a b c',
      );
    });
  });
}
