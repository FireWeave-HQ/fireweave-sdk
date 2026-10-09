"""Redaction parity: every vector in contracts/errors.json ``rules.redaction``
goes through the real core redactor (contracts/errors.md rule 2, start-profile
SP-26), and the contract's lists match the redactor's own."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from fireweave import AuthenticationError, redact_secrets
from fireweave.domain import errors as core_errors

REPO_ROOT = Path(__file__).resolve().parents[3]
RULES = json.loads((REPO_ROOT / "contracts" / "errors.json").read_text(encoding="utf-8"))["rules"]["redaction"]


def test_the_contract_has_vectors():
    assert len(RULES["vectors"]) >= 16


@pytest.mark.parametrize("vector", RULES["vectors"], ids=lambda v: v["in"])
def test_every_contract_vector(vector):
    assert redact_secrets(vector["in"]) == vector["out"]


@pytest.mark.parametrize("vector", RULES["vectors"], ids=lambda v: v["in"])
def test_error_messages_use_the_same_redactor(vector):
    assert AuthenticationError(vector["in"]).message == vector["out"]


def test_the_placeholder_names_and_prefixes_match_the_contract():
    assert core_errors.REDACTION_PLACEHOLDER == RULES["placeholder"]
    assert list(core_errors._ASSIGNMENT_NAMES) == RULES["assignmentNames"]
    assert list(core_errors._VALUE_PREFIXES) == RULES["valuePrefixes"]


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        # A longer name that merely ends in a scrubbed name is out of scope.
        ("MY_FIREWEAVE_KEY=keep", "MY_FIREWEAVE_KEY=keep"),
        # Single quotes and spaced separators keep the name and the quote.
        ("FIREWEAVE_KEY = 'abc', next", "FIREWEAVE_KEY = '[REDACTED]', next"),
        # Order: the assignment runs before the key-shaped value pass.
        ("FW_PROJECT_API_KEY=phc_abc;", "FW_PROJECT_API_KEY=[REDACTED];"),
        # A key glued to other text is still a key.
        ("x=phx_abc", "x=[REDACTED]"),
        ("Authorization: Bearer abc.def", "Authorization: Bearer [REDACTED]"),
        # Order: bearer runs before the key-shaped value pass, so a token that
        # holds a key shape is replaced whole.
        ("Bearer abc.phc_def sent", "Bearer [REDACTED] sent"),
    ],
)
def test_edges_beyond_the_vectors(text, expected):
    assert redact_secrets(text) == expected
