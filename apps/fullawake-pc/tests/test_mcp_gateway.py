"""Tests for FullAwake MCP Gateway and Protocol Handling."""

import json

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


@pytest.mark.parametrize("long_titles", (False, True))
def test_mcp_window_list_adheres_to_hard_text_budget(client, monkeypatch, long_titles):
    from fullawake.capabilities.desktop_vision import tools

    monkeypatch.setattr(tools, "get_session_status", lambda: {"locked": False})
    monkeypatch.setattr(tools, "list_top_level_windows", lambda: [
        {"hwnd": i + 1, "title": '窗😀"\\' * 30 if long_titles else "窗",
         "process_name": "game.exe" if long_titles else "g", "monitor_id": 2,
         "is_foreground": i == 20, "is_minimized": i == 1}
        for i in range(30)
    ])
    headers = {"Authorization": f"Bearer {config.auth_token}"}
    response = client.post("/mcp", headers=headers, json={
        "jsonrpc": "2.0", "id": 12, "method": "tools/call", "params": {"name": "pc_list_windows"},
    })
    content = response.json()["result"]["content"][0]["text"]
    windows = json.loads(content)["windows"]
    assert len(content.encode("utf-16-le")) // 2 <= 800
    assert len(windows) <= 12
    assert windows[0]["hwnd"] == 21
    assert len(windows[0]["title"]) <= 48
    assert set(windows[0]) == {"hwnd", "title", "process", "monitor_id"}
    assert 2 not in [item["hwnd"] for item in windows]


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
