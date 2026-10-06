"""Start profile: the pure resolver (fireweave/start/_resolve.py), the
channel derivation and the control-points object. Precedence, the mode rule, the
endpoint from the SDK channel, key families, URL rules.
"""

from __future__ import annotations

import pytest

from fireweave import ConfigurationError, ErrorKind
from fireweave.start import define_control_points
from fireweave.start._build_info import channel_for_version
from fireweave.start._env import env_from_mapping
from fireweave.start._resolve import resolve_start

KEY = "project-api-key_abc123"


def resolve(env=None, *, channel="production", **options):
    return resolve_start(read=env_from_mapping(env or {}), sdk_version="2.4.0", channel=channel, **options)


def no_env(name):
    raise AssertionError(f"unexpected env read: {name}")


def config_message(**kwargs) -> str:
    with pytest.raises(ConfigurationError) as info:
        resolve(**kwargs)
    assert info.value.kind is ErrorKind.CONFIGURATION
    assert info.value.openfeature_error_code == "PROVIDER_FATAL"
    return info.value.message


class TestExplicitMode:
    def test_remote_with_a_key_is_remote(self):
        r = resolve({"APP_ENV": "development"}, mode="remote", key=KEY)
        assert (r.mode, r.mode_source) == ("remote", "option")

    def test_remote_without_a_key_is_a_start_error_naming_fireweave_key(self):
        message = config_message(mode="remote")
        assert "mode='remote'" in message and "FIREWEAVE_KEY" in message

    def test_local_ignores_a_present_key_with_a_warning(self):
        r = resolve({"FIREWEAVE_KEY": KEY, "APP_ENV": "production"}, mode="local")
        assert r.mode == "local" and r.key is None and r.url is None
        assert "ignores the key from FIREWEAVE_KEY" in "\n".join(r.warnings)

    def test_local_ignores_a_key_option_and_names_the_option(self):
        r = resolve(mode="local", key=KEY)
        assert "start(key=...)" in r.warnings[0]
        assert KEY not in r.warnings[0]

    def test_an_unknown_mode_is_rejected(self):
        assert "must be 'remote' or 'local'" in config_message(mode="auto")


class TestInferredMode:
    def test_a_key_means_remote_whatever_the_environment_says(self):
        r = resolve({"FIREWEAVE_KEY": KEY, "FIREWEAVE_ENV": "development"})
        assert (r.mode, r.mode_source, r.environment) == ("remote", "key", None)

    @pytest.mark.parametrize("name", ["development", "dev", "local", "test", "Development", " LOCAL "])
    def test_no_key_and_a_dev_environment_means_local(self, name):
        r = resolve({"APP_ENV": name})
        assert (r.mode, r.mode_source, r.key_source) == ("local", "environment", "none")
        assert r.environment == name.strip()

    def test_the_environment_option_beats_fireweave_env_and_app_env(self):
        r = resolve({"FIREWEAVE_ENV": "production", "APP_ENV": "production"}, environment="dev")
        assert r.mode == "local" and r.environment_source == "start(environment=...)"

    def test_fireweave_env_beats_app_env(self):
        r = resolve({"FIREWEAVE_ENV": "test", "APP_ENV": "production"})
        assert r.environment_source == "FIREWEAVE_ENV"

    def test_no_key_and_a_non_dev_environment_fails_closed_naming_the_source(self):
        message = config_message(env={"APP_ENV": "production"})
        assert "FIREWEAVE_KEY is not set" in message
        assert "'production' (from APP_ENV)" in message

    def test_no_key_and_no_environment_fails_closed(self):
        message = config_message()
        assert "no environment name is set" in message
        assert "FIREWEAVE_ENV and APP_ENV" in message

    @pytest.mark.parametrize("name", ["ENVIRONMENT", "ENV", "NODE_ENV", "FW_ENV"])
    def test_other_environment_variables_do_not_select_local(self, name):
        config_message(env={name: "development"})

    def test_points_at_fireweave_env_when_only_the_retired_fw_env_is_set(self):
        assert "FW_ENV is no longer read; rename it to FIREWEAVE_ENV" in config_message(env={"FW_ENV": "dev"})

    def test_fw_env_is_not_mentioned_when_it_is_unset(self):
        assert "FW_ENV" not in config_message()

    def test_empty_and_whitespace_values_count_as_unset(self):
        r = resolve({"FIREWEAVE_KEY": "  ", "FIREWEAVE_ENV": "", "APP_ENV": "dev"}, key="", environment=" ")
        assert r.mode == "local" and r.environment_source == "APP_ENV"

    def test_explicit_key_and_url_options_never_read_the_environment(self):
        r = resolve_start(read=no_env, sdk_version="2.4.0", channel="production", key=KEY, url="https://fw.example.com")
        assert r.mode == "remote"


class TestEndpoint:
    def test_a_production_build_calls_app_server(self):
        r = resolve({"FIREWEAVE_KEY": KEY})
        assert r.url == "https://app-server.fireweave.ai"
        assert r.url_source == "SDK channel (production)"
        assert r.allowed_hosts is None

    def test_a_staging_build_calls_staging_app_server(self):
        r = resolve({"FIREWEAVE_KEY": KEY}, channel="staging")
        assert r.url == "https://staging-app-server.fireweave.ai"
        assert r.url_source == "SDK channel (staging)"

    def test_both_channel_hosts_are_in_the_cores_default_allowlist(self):
        from fireweave import DEFAULT_ALLOWED_HOSTS
        from fireweave.start._names import CHANNEL_URLS

        for url in CHANNEL_URLS.values():
            assert url.split("://", 1)[1] in DEFAULT_ALLOWED_HOSTS

    def test_the_url_option_wins_and_the_allowlist_follows_it(self):
        r = resolve({"FIREWEAVE_KEY": KEY, "FIREWEAVE_URL": "https://other.example.com"}, url="https://fw.example.com/")
        assert r.url == "https://fw.example.com"
        assert r.url_source == "start(url=...)"
        assert r.allowed_hosts == ("fw.example.com", "localhost", "127.0.0.1", "::1")

    def test_fireweave_url_beats_the_channel_and_the_legacy_names(self):
        r = resolve({"FIREWEAVE_KEY": KEY, "FIREWEAVE_URL": "https://a.example.com", "FW_API_URL": "https://b.example.com"})
        assert (r.url, r.url_source, r.warnings) == ("https://a.example.com", "FIREWEAVE_URL", ())

    @pytest.mark.parametrize("name", ["FW_API_URL", "FW_ATTEST_URL"])
    def test_legacy_url_names_are_read_with_a_warning(self, name):
        r = resolve({"FIREWEAVE_KEY": KEY, name: "https://legacy.example.com"})
        assert (r.url, r.url_source) == ("https://legacy.example.com", name)
        assert f"{name} is a legacy name" in r.warnings[0] and "FIREWEAVE_URL" in r.warnings[0]

    def test_fw_api_url_beats_fw_attest_url(self):
        r = resolve({"FIREWEAVE_KEY": KEY, "FW_ATTEST_URL": "https://b.example.com", "FW_API_URL": "https://a.example.com"})
        assert r.url_source == "FW_API_URL"

    @pytest.mark.parametrize("url", ["http://localhost:3000", "http://127.0.0.1:3901", "http://[::1]:3000"])
    def test_http_is_allowed_on_loopback(self, url):
        r = resolve({"FIREWEAVE_KEY": KEY}, url=url)
        assert r.url == url

    def test_http_off_loopback_fails_and_never_echoes_the_url(self):
        message = config_message(env={"FIREWEAVE_KEY": KEY, "FIREWEAVE_URL": "http://u:SENTINELPW@fw.example.com"})
        assert "FIREWEAVE_URL must use https" in message
        assert "SENTINELPW" not in message and "fw.example.com" not in message

    @pytest.mark.parametrize("url", ["not a url", "ftp://fw.example.com", "https://"])
    def test_an_invalid_url_names_its_source(self, url):
        message = config_message(key=KEY, url=url)
        assert "endpoint from start(url=...) is not a valid" in message

    def test_local_mode_resolves_no_endpoint(self):
        r = resolve({"FIREWEAVE_URL": "https://fw.example.com", "APP_ENV": "dev"})
        assert r.url is None and r.url_source is None


class TestKey:
    def test_the_key_option_beats_fireweave_key(self):
        r = resolve({"FIREWEAVE_KEY": "project-api-key_env"}, key=KEY)
        assert (r.key, r.key_source) == (KEY, "start(key=...)")

    def test_fireweave_key_beats_the_legacy_name_without_a_warning(self):
        r = resolve({"FIREWEAVE_KEY": KEY, "FW_PROJECT_API_KEY": "project-api-key_old"})
        assert (r.key_source, r.warnings) == ("FIREWEAVE_KEY", ())

    def test_legacy_fw_project_api_key_is_read_with_a_warning(self):
        r = resolve({"FW_PROJECT_API_KEY": KEY})
        assert (r.mode, r.key_source) == ("remote", "FW_PROJECT_API_KEY")
        assert "FW_PROJECT_API_KEY is a legacy name" in r.warnings[0]
        assert KEY not in r.warnings[0]

    def test_the_key_is_not_in_repr(self):
        assert KEY not in repr(resolve(key=KEY))

    def test_a_browser_key_is_rejected_without_printing_it(self):
        message = config_message(env={"FIREWEAVE_KEY": "fw_public_SENTINEL"})
        assert "FIREWEAVE_KEY is a browser key" in message
        assert "SENTINEL" not in message

    @pytest.mark.parametrize("letter", ["c", "s", "x"])
    def test_analytics_vendor_keys_are_rejected(self, letter):
        vendor_key = "ph" + letter + "_SENTINEL"
        message = config_message(key=vendor_key)
        assert "start(key=...) is an analytics vendor key" in message
        assert "SENTINEL" not in message

    @pytest.mark.parametrize("token", ["fw_org_SENTINEL", "cli_at_SENTINEL"])
    def test_org_and_cli_tokens_are_rejected(self, token):
        message = config_message(env={"FW_PROJECT_API_KEY": token})
        assert "FW_PROJECT_API_KEY is an organisation or CLI token" in message
        assert "SENTINEL" not in message

    def test_the_family_check_runs_even_when_mode_is_remote(self):
        assert "browser key" in config_message(mode="remote", key="fw_public_x")

    @pytest.mark.parametrize("option", ["key", "url", "environment"])
    def test_a_non_string_option_is_rejected(self, option):
        assert f"start({option}=...) must be a string" in config_message(**{option: 123})


class TestChannel:
    @pytest.mark.parametrize(
        "version",
        ["2.4.0a1", "2.4.0a12", "2.4.0b1", "2.4.0rc2", "2.4.0c1", "2.4.0.dev3", "2.4.0a1.dev1",
         "2.4.0-alpha.1", "2.4.0.post1.dev2", "1!2.4.0a1", "2.4.0a1+local.7"],
    )
    def test_a_pep440_prerelease_is_staging(self, version):
        assert channel_for_version(version) == "staging"

    @pytest.mark.parametrize(
        "version", ["2.4.0", "2.2.0", "2.4.0.post1", "2.4.0-1", "2.4.0+local", "0+unknown", "", "garbage"]
    )
    def test_anything_else_is_production(self, version):
        assert channel_for_version(version) == "production"

    def test_sdk_version_and_channel_are_exposed_and_agree(self):
        from importlib.metadata import version

        from fireweave.start import SDK_CHANNEL, SDK_VERSION

        assert SDK_VERSION == version("fireweave")
        assert SDK_CHANNEL == channel_for_version(SDK_VERSION)


class TestControlPoints:
    def test_define_control_points_returns_its_argument(self):
        mapping = {"new-checkout": {"local": True, "description": "One-page checkout"}, "old": {"local": False}}
        assert define_control_points(mapping) is mapping

    def test_resolve_copies_the_control_points(self):
        r = resolve({"APP_ENV": "dev"}, control_points={"a": {"local": True, "description": "x"}})
        assert r.control_points == {"a": {"local": True, "description": "x"}}

    @pytest.mark.parametrize(
        "control_points, fragment",
        [
            ({"a": {"local": 1}}, "must be {\"local\": True}"),
            ({"a": {"local": "yes"}}, "must be {\"local\": True}"),
            ({"a": {}}, "must be {\"local\": True}"),
            ({"a": True}, "must be {\"local\": True}"),
            ({"": {"local": True}}, "not a valid control point key"),
            ({"bad\nkey": {"local": True}}, "not a valid control point key"),
            ({"a": {"local": True, "description": 3}}, "['description'] must be a string"),
            (["a"], "must be a mapping"),
        ],
    )
    def test_invalid_control_points_are_rejected(self, control_points, fragment):
        with pytest.raises(ConfigurationError) as info:
            define_control_points(control_points)
        assert fragment in info.value.message
        assert fragment in config_message(env={"APP_ENV": "dev"}, control_points=control_points)

    def test_control_points_are_validated_in_remote_mode_too(self):
        assert "not a valid control point key" in config_message(key=KEY, control_points={"": {"local": True}})
