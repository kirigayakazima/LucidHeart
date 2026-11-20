from pathlib import Path
from unittest.mock import Mock

from fullawake_desktop.supervisor import Supervisor, base_python, usb_devices


def test_usb_selects_only_authorized_physical_device_and_repairs_missing_reverse(monkeypatch):
    listing = 'List of devices attached\nphone device\nemulator-5554 device\nother unauthorized\n192.0.2.1:5555 device'
    assert usb_devices(listing) == ['phone']
    monkeypatch.delenv('FULLAWAKE_ADB_SERIAL', raising=False)
    supervisor = Supervisor({'adb_path': 'fixture-adb.exe'})
    supervisor._adb = Mock(side_effect=[listing, '', '', listing, 'UsbFfs tcp:28765 tcp:8765'])
    supervisor.refresh_usb()
    supervisor.refresh_usb()
    assert supervisor.usb
    assert [call.args for call in supervisor._adb.call_args_list].count(
        ('-s', 'phone', 'reverse', 'tcp:28765', 'tcp:8765')) == 1


def test_gateway_uses_base_python_and_closes_only_owned_children(tmp_path, monkeypatch):
    (tmp_path / 'python.exe').touch()
    (tmp_path / 'pyvenv.cfg').write_text(f'home = {tmp_path}\n')
    assert base_python(tmp_path) == Path(tmp_path / 'python.exe')
    monkeypatch.setenv('FULLAWAKE_AUTH_TOKEN', 'fixture-phone-token-only-987654321')
    supervisor = Supervisor(config={})
    monkeypatch.setattr('fullawake_desktop.supervisor.socket.create_connection', Mock(side_effect=OSError))
    gateway = Mock()
    renderer = Mock()
    for process in (gateway, renderer):
        process.poll.return_value = None
    supervisor._launch = Mock(side_effect=[gateway, renderer])
    supervisor.start_gateway()
    command, environment = supervisor._launch.call_args_list[0].args
    assert command == 'fullawake.gateway.mcp_server'
    assert environment['FULLAWAKE_BIND_HOST'] == '127.0.0.1'
    assert environment['FULLAWAKE_DESKTOP_TOKEN'] != environment['FULLAWAKE_AUTH_TOKEN']
    supervisor.close()
    gateway.terminate.assert_called_once()
    renderer.terminate.assert_called_once()


def test_existing_gateway_is_never_adopted_or_killed(monkeypatch):
    monkeypatch.setenv('FULLAWAKE_AUTH_TOKEN', 'fixture-phone-token-only-987654321')
    monkeypatch.setattr('fullawake_desktop.supervisor.socket.create_connection', Mock(return_value=MagicConnection()))
    supervisor = Supervisor(config={})
    supervisor._launch = Mock()
    supervisor.start_gateway()
    assert '8765' in supervisor.gateway_error
    supervisor.close()
    supervisor._launch.assert_not_called()


class MagicConnection:
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False
