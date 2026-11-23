import base64
from io import BytesIO

import httpx
from PIL import Image
import pytest

from fullawake_desktop.api_bridge import ConsoleApi
from fullawake_desktop.supervisor import Supervisor


def test_home_uses_fixed_local_route_and_state_poll_never_performs_io():
    calls = []
    supervisor = Supervisor({})
    supervisor._pet_alive_cache = True

    def respond(request):
        calls.append(request)
        return httpx.Response(200, json={
            'phone_online': True, 'stale': False, 'sceneState': {'place': 'window', 'source': 'decoration'},
            'recentAlbum': [],
        })

    api = ConsoleApi(supervisor, transport=httpx.MockTransport(respond))
    try:
        assert not api.state()['gateway_online']
        assert not calls
        home = api.home()
        assert home['sceneState']['source'] == 'decoration' and home['pet_running']
        request, = calls
        assert str(request.url) == 'http://127.0.0.1:8765/v1/desktop/home'
        assert request.headers['Authorization'] == f'Bearer {supervisor.token}'
        assert request.extensions['timeout']['read'] == 2.0
        api._state = {'home': {'stale': False, 'sceneState': {'place': 'sofa', 'source': 'pc'}}}
        assert api.state()['home']['sceneState']['place'] == 'sofa'
        assert len(calls) == 1
    finally:
        api._close()


@pytest.mark.parametrize('size', [(960, 560), (1600, 900), (3200, 1800)])
def test_export_only_accepts_bounded_png_and_requires_a_native_selection(tmp_path, size):
    api = ConsoleApi(Supervisor({}))
    image = BytesIO()
    Image.new('RGB', size, '#ffd5ab').save(image, format='PNG')
    encoded = base64.b64encode(image.getvalue()).decode()
    destination = tmp_path / 'home.png'
    try:
        assert api.save_home_image(encoded) == {'saved': False}
        api._select_home_export = lambda: (str(destination),)
        assert 'error' in api.save_home_image('not an image')
        assert not destination.exists()
        assert api.save_home_image(encoded) == {'saved': True}
        assert destination.read_bytes() == image.getvalue()
    finally:
        api._close()
