import json
import httpx

from fullawake_desktop.api_bridge import ConsoleApi
from fullawake_desktop.supervisor import Supervisor


def test_fixed_gui_commands_and_error_do_not_forward_credentials():
    calls = []
    supervisor = Supervisor({})
    def respond(request):
        assert request.headers['Authorization'] == f'Bearer {supervisor.token}'
        assert request.url.host == '127.0.0.1' and request.url.port == 8765
        calls.append((request.url.path, json.loads(request.content) if request.content else None))
        return httpx.Response(403, json={'error': supervisor.token}) if request.url.path.endswith('preview') else httpx.Response(200, json={'accepted': True})
    api = ConsoleApi(supervisor, transport=httpx.MockTransport(respond))
    try:
        assert api.call(True)['accepted']
        assert api.watch(False)['accepted']
        assert api.target({'kind': 'monitor', 'monitor_id': 2})['accepted']
        assert supervisor.token not in api.preview()['error']
        assert calls == [
            ('/v1/desktop/call', {'enabled': True}), ('/v1/desktop/watch', {'action': 'stop', 'mode': 'desktop'}),
            ('/v1/desktop/target', {'kind': 'monitor', 'monitor_id': 2}), ('/v1/desktop/preview', None),
        ]
    finally:
        api._close()
