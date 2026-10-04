import 'package:fireweave/fireweave.dart';
import 'package:test/test.dart';

void main() {
  group('InMemoryAdapter', () {
    test('missing flag is absent from the batch', () async {
      final adapter = InMemoryAdapter();
      final result = await adapter.prefetch(EvaluationContext());
      expect(result, isEmpty);
    });

    test('matchAttribute gates the match', () async {
      final adapter = InMemoryAdapter.fromFlagsJson({
        'f': {
          'type': 'boolean',
          'enabled': true,
          'variant': 'on',
          'value': true,
          'matchAttribute': {'tier': 'gold'},
        },
      });
      final matching = await adapter.prefetch(
        EvaluationContext(attributes: {'tier': 'gold'}),
      );
      expect(matching['f']?.found, isTrue);

      final notMatching = await adapter.prefetch(
        EvaluationContext(attributes: {'tier': 'bronze'}),
      );
      expect(notMatching['f']?.found, isFalse);
    });

    test('matchPerson behaves like matchAttribute', () async {
      final adapter = InMemoryAdapter.fromFlagsJson({
        'f': {
          'type': 'boolean',
          'enabled': true,
          'value': true,
          'matchPerson': {'email_domain': 'example.com'},
        },
      });
      final result = await adapter.prefetch(
        EvaluationContext(attributes: {'email_domain': 'example.com'}),
      );
      expect(result['f']?.found, isTrue);
    });

    test('matchGroups reads groups through the canonical key', () async {
      final adapter = InMemoryAdapter.fromFlagsJson({
        'f': {
          'type': 'boolean',
          'enabled': true,
          'value': true,
          'matchGroups': {'organization': 'org_1'},
        },
      });
      final hit = await adapter.prefetch(
        EvaluationContext(
          attributes: {
            'fireweave.groups': {'organization': 'org_1'},
          },
        ),
      );
      expect(hit['f']?.found, isTrue);
      final miss = await adapter.prefetch(EvaluationContext());
      expect(miss['f']?.found, isFalse);
    });

    test('fault overrides every prefetch', () async {
      final adapter = InMemoryAdapter();
      adapter.setFault(const InMemoryFault(ErrorKind.backendUnavailable));
      await expectLater(
        adapter.prefetch(EvaluationContext()),
        throwsA(isA<FireweaveError>()),
      );
    });

    test('vendor metadata gate requires all three signals', () async {
      // vendorFlagId + reasonCode but NO condition_index -> gate fails.
      final adapter = InMemoryAdapter.fromFlagsJson({
        'f': {
          'type': 'boolean',
          'enabled': true,
          'value': true,
          'metadata': {'id': 7},
          'reason': {'code': 'condition_match'},
        },
      });
      final result = await adapter.prefetch(EvaluationContext());
      expect(result['f']?.vendorFlagId, isNull);
      expect(result['f']?.reasonCode, isNull);
    });

    test('registerTarget degrades with UnsupportedCapability', () async {
      final result = await InMemoryAdapter().registerTarget('u');
      expect(result.ok, isFalse);
      expect(result.error?.kind, ErrorKind.unsupportedCapability);
    });
  });
}
