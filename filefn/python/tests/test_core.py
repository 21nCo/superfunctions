def test_import_sanity_package_exists() -> None:
    import filefn
    from filefn import FileFn, FileFnConfig, create_file_fn

    assert filefn is not None
    assert callable(create_file_fn)
    assert FileFn is not None
    assert FileFnConfig is not None


def test_top_level_exports_documented_server_entrypoints() -> None:
    import filefn
    from filefn.server import FileFn, FileFnConfig, create_file_fn

    assert filefn.create_file_fn is create_file_fn
    assert filefn.FileFnConfig is FileFnConfig
    assert filefn.FileFn is FileFn


def test_processing_package_exports_documented_processor_factories() -> None:
    from filefn import processing

    assert callable(processing.create_thumbnail_processor)
    assert callable(processing.create_compression_processor)
    assert callable(processing.create_ocr_processor)
    assert callable(processing.create_image_transform_processor)
    assert callable(processing.create_video_processor)
    assert callable(processing.create_audio_processor)


def test_filefn_config_exposes_auth_rate_limit_and_dedup_surfaces() -> None:
    from filefn.server import (
        AuthConfig,
        DedupConfig,
        FileFnConfig,
        RateLimitCategoryConfig,
        RateLimitConfig,
        RateLimitLimitsConfig,
    )

    rate_limit = RateLimitConfig(
        persistence=object(),
        limits=RateLimitLimitsConfig(
            upload_init=RateLimitCategoryConfig(window_seconds=60, max_requests=5),
            download=RateLimitCategoryConfig(windowSeconds=30, maxRequests=10),
        ),
    )
    config = FileFnConfig(
        db=object(),
        storage=object(),
        auth=AuthConfig(required=True, allow_anonymous_uploads=False),
        rate_limit=rate_limit,
        dedup=DedupConfig(enabled=True),
    )

    assert config.auth is not None
    assert config.auth.required is True
    assert config.auth.allow_anonymous_uploads is False
    assert config.rate_limit is not None
    assert config.rate_limit.limits.upload_init is not None
    assert config.rate_limit.limits.upload_init.window_seconds == 60
    assert config.rate_limit.limits.download is not None
    assert config.rate_limit.limits.download.max_requests == 10
    assert config.dedup is not None
    assert config.dedup.enabled is True


def test_policy_registry_define_accepts_policy_dicts() -> None:
    from filefn.server.policies import create_policy_registry

    registry = create_policy_registry()
    registry.define("avatars", {"storageTarget": "durable", "visibility": "private"})

    policy = registry.get("avatars")
    assert policy is not None
    assert policy.storageTarget == "durable"
    assert policy.visibility == "private"


def test_unparseable_grant_expiry_counts_as_expired() -> None:
    # FILE-30 F-08: a grant whose expiresAt does not parse must not live forever.
    from filefn.server.files.service import FileService

    assert FileService._is_grant_expired(object.__new__(FileService), "not-a-date") is True
    assert FileService._is_grant_expired(object.__new__(FileService), None) is False
    assert FileService._is_grant_expired(object.__new__(FileService), "2999-01-01T00:00:00Z") is False


def test_grant_expiry_helper_fails_closed() -> None:
    from filefn.server.authz.grant_expiry import is_grant_expired

    assert is_grant_expired("not-a-date")
    assert is_grant_expired("2001-01-01T00:00:00Z")
    assert not is_grant_expired("2999-01-01T00:00:00Z")
    assert not is_grant_expired(None)


def test_iso_instant_outside_utc_year_range_is_refused() -> None:
    from filefn.server.authz.grant_expiry import is_grant_expired, parse_iso_instant

    assert parse_iso_instant("9999-12-31T23:59:59-01:00") is None
    assert parse_iso_instant("0001-01-01T00:00:00+01:00") is None
    assert is_grant_expired("9999-12-31T23:59:59-01:00")
    assert parse_iso_instant("9999-12-31T22:59:59-01:00") is not None


def test_iso_instant_accepts_offsets_with_or_without_a_colon() -> None:
    from datetime import datetime, timezone

    from filefn.server.authz.grant_expiry import parse_iso_instant

    expected = datetime(2030, 1, 1, 12, 30, tzinfo=timezone.utc)
    assert parse_iso_instant("2030-01-01T18:00:00+0530") == expected
    assert parse_iso_instant("2030-01-01T18:00:00+05:30") == expected
    assert parse_iso_instant("2030-01-01T18:00:00+0560") is None
    assert parse_iso_instant("2030-01-01T18:00:00+053") is None


def test_iso_instant_requires_a_full_ascii_match() -> None:
    from filefn.server.authz.grant_expiry import is_grant_expired, parse_iso_instant

    assert parse_iso_instant("2099-01-01T00:00:00Z\n") is None
    assert parse_iso_instant("\u0662\u0660\u0669\u0669-01-01") is None
    assert is_grant_expired("2099-01-01T00:00:00Z\n")


def test_image_wildcard_does_not_admit_svg() -> None:
    # FILE-30 F-04: SVG can run script, so `image/*` must not accept it.
    from filefn.server.policies import matches_content_type

    assert matches_content_type("image/*", "image/png")
    assert not matches_content_type("image/*", "image/svg+xml")
    assert not matches_content_type("image/*", "IMAGE/SVG+XML; charset=utf-8")
    assert matches_content_type("image/svg+xml", "image/svg+xml")
