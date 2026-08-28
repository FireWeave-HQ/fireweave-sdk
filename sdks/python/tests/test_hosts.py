"""SSRF allowlist (infrastructure/hosts.py): ON by default, canonical Fireweave
host list, https required off-loopback, http permitted on loopback only."""

from __future__ import annotations

import pytest

from fireweave import DEFAULT_ALLOWED_HOSTS, ConfigurationError, assert_host_allowed


def test_default_allowlist_is_canonical():
    assert DEFAULT_ALLOWED_HOSTS == (
        "app-server.fireweave.ai",
        "staging-app-server.fireweave.ai",
        "localhost",
        "127.0.0.1",
        "::1",
    )


@pytest.mark.parametrize(
    "host",
    [
        "https://app-server.fireweave.ai",
        "https://staging-app-server.fireweave.ai",
        "https://APP-SERVER.FIREWEAVE.AI",  # hostname match is case-insensitive
        "http://localhost:3901",
        "http://127.0.0.1:3901",
        "https://127.0.0.1:3901",
    ],
)
def test_default_allowed_hosts_accepted(host):
    assert_host_allowed(host)


def test_unlisted_host_rejected_by_default():
    """No explicit allowed_hosts -> unknown hosts denied."""
    with pytest.raises(ConfigurationError):
        assert_host_allowed("https://169.254.169.254")
    with pytest.raises(ConfigurationError):
        assert_host_allowed("https://evil.example.com")


def test_http_rejected_for_non_loopback_even_when_allowlisted():
    with pytest.raises(ConfigurationError):
        assert_host_allowed("http://app-server.fireweave.ai")
    with pytest.raises(ConfigurationError):
        assert_host_allowed(
            "http://selfhosted.example.com",
            allowed_hosts=("selfhosted.example.com",),
        )


def test_self_hosted_requires_explicit_opt_in():
    with pytest.raises(ConfigurationError):
        assert_host_allowed("https://fw.internal.example.com")
    assert_host_allowed(
        "https://fw.internal.example.com",
        allowed_hosts=("fw.internal.example.com",),
    )


def test_wildcard_opt_out_disables_host_pinning():
    assert_host_allowed("https://anything.example.com", allowed_hosts=("*",))
    # https is still required off-loopback even with the wildcard.
    with pytest.raises(ConfigurationError):
        assert_host_allowed("http://anything.example.com", allowed_hosts=("*",))


def test_non_http_scheme_rejected():
    with pytest.raises(ConfigurationError):
        assert_host_allowed("ftp://app-server.fireweave.ai")


def test_malformed_url_rejected():
    with pytest.raises(ConfigurationError):
        assert_host_allowed("not-a-url")


def test_init_fatal_maps_to_provider_fatal():
    """contracts/security/sec-endpoint-ssrf-allowlist.json: a host-allowlist
    rejection during initialize() must map to errorCode PROVIDER_FATAL, not
    GENERAL — both real call sites (application/mode.py,
    infrastructure/adapters/remote.py's initialize()) pass init_fatal=True."""
    with pytest.raises(ConfigurationError) as excinfo:
        assert_host_allowed("https://169.254.169.254", init_fatal=True)
    assert excinfo.value.openfeature_error_code == "PROVIDER_FATAL"


def test_default_init_fatal_false_maps_to_general():
    with pytest.raises(ConfigurationError) as excinfo:
        assert_host_allowed("https://169.254.169.254")
    assert excinfo.value.openfeature_error_code == "GENERAL"
