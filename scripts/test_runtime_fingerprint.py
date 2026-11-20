from runtime_fingerprint import audit_dns, probe_adb_dns_server


def test_dns_readonly_detects_offline_tun_and_accepts_live_resolver():
    content = 'nameserver 172.19.0.2\nnameserver 198.18.0.1\n'
    result = audit_dns(content, lambda _: False)
    assert result['status'] == 'degraded' and result['reason'] == 'dns_unreachable'
    assert all(row['virtual'] for row in result['servers'])
    assert result['active_data_changed'] is False
    assert audit_dns(content, lambda _: True)['status'] == 'available'
    assert audit_dns(content + 'nameserver 223.5.5.5\n', lambda ip: ip == '223.5.5.5')['status'] == 'available'
    assert audit_dns('')['status'] == 'unknown'


def test_dns_invalid_configuration_and_socket_failure_are_visible():
    def unreachable(_):
        raise OSError('offline')
    assert audit_dns('nameserver invalid')['reason'] == 'dns_unreachable'
    assert audit_dns('nameserver 172.19.0.2', unreachable)['servers'][0]['reachable'] is False


def test_adb_probe_uses_android_network_and_does_not_write_files():
    class Adb:
        def shell(self, command):
            assert 'toybox nc -u -w 1 172.19.0.2 53' in command
            assert '>' not in command and 'resolv.conf' not in command
            return 'unsupported toybox nc'
    assert probe_adb_dns_server(Adb(), '172.19.0.2') is None
    assert audit_dns('nameserver 172.19.0.2', lambda _: None)['status'] == 'unknown'
