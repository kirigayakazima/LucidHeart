"""Connect phone localhost:28765 to PC localhost:8765 via native ADB Socket.

Uses an already-authorized USB device; no app/Proot files are modified. Run again
after ADB reconnect. An unrelated existing mapping is never replaced.
"""
import argparse
import socket


def read_exact(sock, size):
    result = b''
    while len(result) < size:
        chunk = sock.recv(size - len(result))
        if not chunk:
            raise RuntimeError('ADB_CONNECTION_CLOSED')
        result += chunk
    return result


def send(sock, value):
    data = value.encode()
    sock.sendall(f'{len(data):04x}'.encode() + data)


def okay(sock):
    status = read_exact(sock, 4)
    if status != b'OKAY':
        size = int(read_exact(sock, 4), 16)
        raise RuntimeError(read_exact(sock, size).decode(errors='replace'))


def transport(serial):
    sock = socket.create_connection(('127.0.0.1', 5037), timeout=5)
    send(sock, f'host:transport:{serial}')
    okay(sock)
    return sock


def connect(serial, phone_port, pc_port):
    source, target = f'tcp:{phone_port}', f'tcp:{pc_port}'
    with transport(serial) as sock:
        send(sock, 'reverse:list-forward')
        okay(sock)
        size = int(read_exact(sock, 4), 16)
        mappings = read_exact(sock, size).decode() if size else ''
    for line in mappings.splitlines():
        fields = line.split()
        if len(fields) >= 3 and fields[-2] == source:
            if fields[-1] == target:
                print(f'Already connected: phone {source} -> PC {target}')
                return
            raise RuntimeError('PHONE_PORT_HAS_ANOTHER_MAPPING')
    with transport(serial) as sock:
        send(sock, f'reverse:forward:norebind:{source};{target}')
        okay(sock)
        okay(sock)
    print(f'Connected: phone http://127.0.0.1:{phone_port} -> PC http://127.0.0.1:{pc_port}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--phone-port', type=int, default=28765)
    parser.add_argument('--pc-port', type=int, default=8765)
    args = parser.parse_args()
    if not all(1 <= p <= 65535 for p in (args.phone_port, args.pc_port)):
        raise ValueError('Invalid TCP port')
    connect(args.serial, args.phone_port, args.pc_port)
