import 'package:fireweave/fireweave.dart';
import 'package:test/test.dart';

void main() {
  group('assertHostAllowed (SSRF guard)', () {
    test('loopback http is allowed by default', () {
      assertHostAllowed('http://127.0.0.1:3901', initFatal: true);
      assertHostAllowed('http://localhost:3901', initFatal: true);
      assertHostAllowed('http://[::1]:3901', initFatal: true);
    });

    test('canonical https host is allowed by default', () {
      assertHostAllowed('https://app-server.fireweave.ai', initFatal: true);
    });

    test('non-loopback http is rejected', () {
      expect(
        () => assertHostAllowed('http://example.com', initFatal: true),
        throwsA(isA<FireweaveError>()),
      );
    });

    test(
      'host outside the allowlist is rejected even with an explicit list',
      () {
        const allow = ['127.0.0.1', 'localhost', 'us.i.example.com'];
        expect(
          () => assertHostAllowed(
            'http://169.254.169.254',
            allowedHosts: allow,
            initFatal: true,
          ),
          throwsA(isA<FireweaveError>()),
        );
        expect(
          () => assertHostAllowed(
            'https://evil.example.com',
            allowedHosts: allow,
            initFatal: true,
          ),
          throwsA(isA<FireweaveError>()),
        );
      },
    );

    test('wildcard opts out explicitly', () {
      assertHostAllowed(
        'https://anything.example.com',
        allowedHosts: const ['*'],
        initFatal: true,
      );
    });

    test('malformed URL and non-http scheme are rejected', () {
      expect(
        () => assertHostAllowed('not-a-uri', initFatal: true),
        throwsA(isA<FireweaveError>()),
      );
      expect(
        () => assertHostAllowed('ftp://localhost', initFatal: true),
        throwsA(isA<FireweaveError>()),
      );
    });

    test('rejection carries Configuration kind and no host echo', () {
      try {
        assertHostAllowed('http://evil.example.com', initFatal: true);
        fail('expected a throw');
      } on FireweaveError catch (error) {
        expect(error.kind, ErrorKind.configuration);
        expect(error.message, 'invalid configuration');
        expect(error.openFeatureErrorCode, 'PROVIDER_FATAL');
        expect(error.message, isNot(contains('evil.example.com')));
      }
    });

    test('isLoopbackHostname', () {
      expect(isLoopbackHostname('localhost'), isTrue);
      expect(isLoopbackHostname('::1'), isTrue);
      expect(isLoopbackHostname('example.com'), isFalse);
    });
  });
}
