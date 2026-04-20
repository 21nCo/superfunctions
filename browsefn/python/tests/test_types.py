from browsefn.core.types import ProviderConfig


def test_provider_config_allows_access_to_extra_fields():
    config = ProviderConfig(apiKey="secret", region="us-east-1")

    assert config.api_key == "secret"
    assert config.apiKey == "secret"
    assert config.region == "us-east-1"
