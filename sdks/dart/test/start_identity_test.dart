import 'package:fireweave/src/start/identity.dart';
import 'package:test/test.dart';

void main() {
  group('fnv1a64 (the same function as node and go)', () {
    test('reference vectors', () {
      expect(fnv1a64(''), 'cbf29ce484222325');
      expect(fnv1a64('a'), 'af63dc4c8601ec8c');
      expect(fnv1a64('foobar'), '85944171f73967e8');
    });

    test('host api-pod-1 gives the cross-SDK instance key', () {
      expect('inst_${fnv1a64('api-pod-1')}', 'inst_8148fc8bb0e952ef');
    });

    test('hashes UTF-8 bytes', () {
      expect(fnv1a64('é'), isNot(fnv1a64('e')));
      expect(fnv1a64('é'), hasLength(16));
    });
  });

  group('deriveInstanceKey', () {
    String? Function(String) env(Map<String, String> values) =>
        (name) => values[name];

    test('option, then FIREWEAVE_INSTANCE_ID, then the host, then random', () {
      final withId = env(<String, String>{'FIREWEAVE_INSTANCE_ID': 'worker-7'});
      String host() => 'api-pod-1';
      String? noHost() => null;

      var key = deriveInstanceKey(' cron-1 ', withId, host);
      expect(key.value, 'cron-1');
      expect(key.source, InstanceKeySource.option);

      key = deriveInstanceKey(null, withId, host);
      expect(key.value, 'worker-7');
      expect(key.source.label, 'FIREWEAVE_INSTANCE_ID');

      key = deriveInstanceKey('  ', env(const <String, String>{}), host);
      expect(key.value, 'inst_8148fc8bb0e952ef');
      expect(key.source, InstanceKeySource.host);

      final r1 = deriveInstanceKey(null, env(const <String, String>{}), noHost);
      final r2 = deriveInstanceKey(null, env(const <String, String>{}), noHost);
      expect(r1.source, InstanceKeySource.random);
      expect(r1.value, matches(RegExp(r'^inst_[0-9a-f]{32}$')));
      expect(r1.value, isNot(r2.value));
    });
  });

  test('mintDeviceId is dev_ + a version-4 UUID, fresh each time', () {
    final a = mintDeviceId();
    final b = mintDeviceId();
    final shape = RegExp(
      r'^dev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    );
    expect(a, matches(shape));
    expect(b, matches(shape));
    expect(a, isNot(b));
  });
}
