from pathlib import Path


def test_project_urls_point_to_the_public_repository() -> None:
    manifest = (Path(__file__).resolve().parents[1] / "pyproject.toml").read_text(encoding="utf-8")
    assert 'Documentation = "https://docs.superfunctions.dev/filefn"' in manifest
    assert 'Repository = "https://github.com/21nCo/superfunctions"' in manifest
    assert 'Issues = "https://github.com/21nCo/superfunctions/issues"' in manifest
