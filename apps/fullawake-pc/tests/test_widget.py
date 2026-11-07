from fastapi.testclient import TestClient

from fullawake.widget.__main__ import ClockState, make_app


def test_websocket_clock_round_trip_and_release(tmp_path):
    clock = ClockState()
    token = "local-widget-test-token"
    origin = "http://127.0.0.1:8766"
    with TestClient(make_app(clock, token, 8766, tmp_path / "motion.js")) as client:
        assert "播放时钟" in client.get("/").text
        with client.websocket_connect("/clock?token=" + token, headers={"Origin": origin}) as socket:
            socket.send_json({"mode": "speaking", "utteranceId": "one", "positionMs": 153, "mouth": 2})
            # A bad frame closes after the valid message has been processed in order.
            socket.send_json({"mode": "speaking", "positionMs": -1})
            assert socket.receive()["code"] == 1007
        assert clock.snapshot()["mouth"] == 0
        assert clock.snapshot()["mode"] == "idle"


def test_playback_staleness_releases_mouth_and_reveals_heart_state():
    clock = ClockState()
    clock.publish("heart", {"mode": "resting", "energy": 0.2}, now=0)
    clock.publish("player", {"mode": "speaking", "utteranceId": "one", "positionMs": 153, "mouth": 2}, now=10)
    assert clock.snapshot(now=10.1)["positionMs"] == 153
    assert clock.snapshot(now=10.1)["mouth"] == 2
    assert clock.snapshot(now=10.31) == {"mode": "resting", "energy": 0.2, "mouth": 0, "positionMs": 0}
