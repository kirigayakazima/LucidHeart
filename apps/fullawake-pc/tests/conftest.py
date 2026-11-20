import pytest

from fullawake.core.config import config


@pytest.fixture(autouse=True)
def test_bridge_credential(monkeypatch):
    monkeypatch.setattr(config, 'auth_token', 'fullawake-pytest-fixture-only')
