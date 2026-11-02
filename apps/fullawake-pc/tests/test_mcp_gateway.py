"""Tests for FullAwake MCP Gateway and Protocol Handling."""

import pytest
from fastapi.testclient import TestClient
from fullawake.gateway.mcp_server import app
from fullawake.core.config import config


@pytest.fixture
def client():
    return TestClient(app)


def test_health_check(client):
    res = client.get("/health")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "ok"


def test_status_auth_required(client):
    # No auth header -> 401
    res = client.get("/status")
    assert res.status_code == 401

    # Wrong token -> 403
    res_bad = client.get("/status", headers={"Authorization": "Bearer bad-token"})
    assert res_bad.status_code == 403

    # Correct token -> 200
    res_ok = client.get("/status", headers={"Authorization": f"Bearer {config.auth_token}"})
    assert res_ok.status_code == 200
    assert res_ok.json()["online"] is True


def test_mcp_initialize(client):
    headers = {"Authorization": f"Bearer {config.auth_token}"}
    req = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "test-client", "version": "1.0"},
        },
    }
    res = client.post("/mcp", json=req, headers=headers)
    assert res.status_code == 200
    data = res.json()
    assert data["id"] == 1
    assert data["result"]["serverInfo"]["name"] == "fullawake-pc-bridge"


def test_mcp_tools_list(client):
    headers = {"Authorization": f"Bearer {config.auth_token}"}
    req = {
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/list",
        "params": {},
    }
    res = client.post("/mcp", json=req, headers=headers)
    assert res.status_code == 200
    data = res.json()
    tool_names = [t["name"] for t in data["result"]["tools"]]
    assert "pc_status" in tool_names
    assert "pc_list_windows" in tool_names
    assert "pc_snapshot" in tool_names
    assert "pc_read_file" in tool_names


def test_mcp_call_pc_read_file_safe(client):
    headers = {"Authorization": f"Bearer {config.auth_token}"}
    req = {
        "jsonrpc": "2.0",
        "id": 3,
        "method": "tools/call",
        "params": {
            "name": "pc_read_file",
            "arguments": {
                "path": "projects/lucidheart/apps/fullawake-pc/README.md",
                "start_line": 1,
                "end_line": 5,
            },
        },
    }
    res = client.post("/mcp", json=req, headers=headers)
    assert res.status_code == 200
    data = res.json()
    content = data["result"]["content"]
    assert len(content) > 0
    assert "FullAwake" in content[0]["text"]


def test_mcp_call_pc_read_file_violation(client):
    headers = {"Authorization": f"Bearer {config.auth_token}"}
    req = {
        "jsonrpc": "2.0",
        "id": 4,
        "method": "tools/call",
        "params": {
            "name": "pc_read_file",
            "arguments": {
                "path": "d:\\CodePackage\\DSHA\\projects\\heart-plugin\\package.json",
            },
        },
    }
    res = client.post("/mcp", json=req, headers=headers)
    assert res.status_code == 200
    data = res.json()
    content_text = data["result"]["content"][0]["text"]
    assert "Access denied" in content_text or "protected keyword" in content_text
