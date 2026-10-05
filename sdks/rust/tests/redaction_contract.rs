//! Every vector in `contracts/errors.json` `rules.redaction` through the real
//! redactor, [`fireweave::redact_secrets`] (start-profile spec SP-26).

use std::fs;
use std::path::Path;

use fireweave::redact_secrets;
use serde_json::Value;

fn redaction_rule() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../contracts/errors.json");
    let text = fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let doc: Value = serde_json::from_str(&text).expect("contracts/errors.json is JSON");
    doc["rules"]["redaction"].clone()
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .expect("an array")
        .iter()
        .map(|s| s.as_str().expect("a string").to_string())
        .collect()
}

#[test]
fn every_contract_redaction_vector_passes() {
    let rule = redaction_rule();
    assert_eq!(rule["placeholder"], "[REDACTED]");
    let vectors = rule["vectors"].as_array().expect("vectors");
    assert!(
        vectors.len() >= 16,
        "expected the contract's redaction vectors, got {}",
        vectors.len()
    );
    let mut failures = Vec::new();
    for v in vectors {
        let input = v["in"].as_str().expect("in");
        let want = v["out"].as_str().expect("out");
        let got = redact_secrets(input);
        if got != want {
            failures.push(format!("{input:?} -> {got:?} (want {want:?})"));
        }
        // Redaction is idempotent: a scrubbed line scrubs to itself.
        if redact_secrets(&got) != got {
            failures.push(format!("not idempotent: {got:?}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn every_contract_name_and_prefix_is_covered() {
    let rule = redaction_rule();
    for name in strings(&rule["assignmentNames"]) {
        let alone = format!("set {name} first");
        assert_eq!(redact_secrets(&alone), alone, "a name alone stays");
        assert_eq!(
            redact_secrets(&format!("{name} = 'v4lue'")),
            format!("{name} = '[REDACTED]'")
        );
    }
    for prefix in strings(&rule["valuePrefixes"]) {
        assert_eq!(
            redact_secrets(&format!("k {prefix}Ab-9_z.")),
            "k [REDACTED].",
            "{prefix}"
        );
        let prose = format!("k {prefix}\u{2026}");
        assert_eq!(redact_secrets(&prose), prose, "{prefix}");
    }
}
