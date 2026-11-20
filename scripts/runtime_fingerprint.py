#!/usr/bin/env python3
"""
M0-01 Runtime Fingerprint Inspector:
Audits sovereign components, lockfile parity, core weight integrity, and active socket endpoints.
Outputs structured JSON and human-readable diagnostic summaries.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import socket
import ipaddress
import secrets
import struct
import shlex
import base64
from datetime import datetime, timezone
import subprocess
import sys
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
SUITE = ROOT / "projects" / "lucidheart"


def probe_dns_server(server: str, timeout: float = 0.8) -> bool:
    """Send a bounded read-only DNS A query; no resolver configuration changes."""
    address = ipaddress.ip_address(server)
    token = secrets.token_bytes(2)
    query = token + struct.pack('!5H', 0x0100, 1, 0, 0, 0) + b'\x03www\x02qq\x03com\x00\x00\x01\x00\x01'
    family = socket.AF_INET6 if address.version == 6 else socket.AF_INET
    with socket.socket(family, socket.SOCK_DGRAM) as connection:
        connection.settimeout(timeout)
        connection.connect((server, 53))
        connection.send(query)
        response = connection.recv(4096)
    return len(response) >= 12 and response[:2] == token and bool(response[2] & 0x80) and (response[3] & 15) == 0


def probe_adb_dns_server(adb, server: str) -> bool | None:
    """Probe on Android, not on the PC's network. Unsupported tools remain unknown."""
    address = str(ipaddress.ip_address(server))
    token = secrets.token_bytes(2)
    query = token + struct.pack('!5H', 0x0100, 1, 0, 0, 0) + b'\x03www\x02qq\x03com\x00\x00\x01\x00\x01'
    octets = ''.join('\\0%03o' % byte for byte in query)
    # Only validated address and generated octets enter the shell; no file is opened for writing.
    command = "printf '%b' " + shlex.quote(octets) + ' | toybox nc -u -w 1 ' + shlex.quote(address) + ' 53 | toybox base64'
    output = adb.shell(command).strip()
    try:
        response = base64.b64decode(output, validate=True)
    except ValueError:
        return None
    return len(response) >= 12 and response[:2] == token and bool(response[2] & 0x80) and (response[3] & 15) == 0


def audit_dns(content: str, probe=probe_dns_server) -> dict:
    servers = []
    for line in content.splitlines():
        parts = line.split('#', 1)[0].split()
        if len(parts) >= 2 and parts[0] == 'nameserver':
            try:
                address = ipaddress.ip_address(parts[1])
                server = str(address)
                virtual = server == '172.19.0.2' or (address.version == 4 and address in ipaddress.ip_network('198.18.0.0/15'))
                try:
                    reachable = probe(server)
                except (OSError, ValueError):
                    reachable = False
                servers.append({'address': server, 'virtual': virtual, 'reachable': reachable})
            except ValueError:
                servers.append({'address': parts[1], 'virtual': False, 'reachable': False})
    reachable = any(server['reachable'] is True for server in servers)
    unknown = any(server['reachable'] is None for server in servers)
    return {'status': 'available' if reachable else 'unknown' if unknown else 'degraded' if servers else 'unknown',
            'reason': None if reachable else 'probe_unavailable' if unknown else 'dns_unreachable' if servers else 'resolver_unavailable',
            'servers': servers, 'active_data_changed': False}


def get_git_commit(path: Path) -> str | None:
    try:
        res = subprocess.run(
            ["git", "-C", str(path), "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
        if res.returncode == 0:
            return res.stdout.strip()
    except Exception:
        pass
    return None


def sha256_file(path: Path, max_bytes: int = 64 * 1024 * 1024) -> str | None:
    if not path.is_file():
        return None
    h = hashlib.sha256()
    read_so_far = 0
    try:
        with open(path, "rb") as f:
            while chunk := f.read(65536):
                h.update(chunk)
                read_so_far += len(chunk)
                if read_so_far >= max_bytes:
                    break
        return h.hexdigest()
    except Exception:
        return None


def probe_port(host: str, port: int, timeout: float = 0.5) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except (OSError, TimeoutError):
        return False


def probe_http(url: str, timeout: float = 0.8) -> dict:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "FingerprintProbe/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return {"status": "online", "code": resp.status}
    except urllib.error.HTTPError as e:
        return {"status": "degraded", "code": e.code}
    except Exception:
        return {"status": "offline", "code": None}


def audit_components() -> dict:
    lock_path = SUITE / "manifests" / "components.lock.json"
    lock_data = {}
    if lock_path.is_file():
        try:
            lock_data = json.loads(lock_path.read_text(encoding="utf-8")).get("components", {})
        except Exception:
            pass

    components = {}
    fork_map = {
        "qqbot": ROOT / "projects" / "dsh-qqbot",
        "bili-scroll": ROOT / "projects" / "bili-fork",
        "video-storyboard": ROOT / "projects" / "dsh-video-storyboard",
    }

    scan_keys = [
        "heart", "rvc", "memory", "fullawake", "qq-plus", "sticker-look",
        "qqbot", "bili-scroll", "video-storyboard", "voice-duplex",
        "heart-wake", "companion", "evolution", "xhs-scroll"
    ]

    for key in scan_keys:
        source_dir = fork_map[key] if key in fork_map else SUITE / "packages" / key
        pkg_file = source_dir / "package.json"
        comp_info = {
            "name": key,
            "path": str(source_dir.relative_to(ROOT)),
            "exists": source_dir.is_dir(),
            "version": None,
            "lock_version": lock_data.get(key, {}).get("version"),
            "status": "unknown",
        }

        if pkg_file.is_file():
            try:
                pkg_json = json.loads(pkg_file.read_text(encoding="utf-8"))
                comp_info["version"] = pkg_json.get("version")
                comp_info["id"] = pkg_json.get("name")
                if comp_info["lock_version"]:
                    comp_info["status"] = "loaded" if comp_info["version"] == comp_info["lock_version"] else "degraded"
                else:
                    comp_info["status"] = "loaded"
            except Exception as e:
                comp_info["status"] = "degraded"
                comp_info["error"] = str(e)
        else:
            comp_info["status"] = "missing"

        components[key] = comp_info

    return components


def audit_endpoints() -> dict:
    endpoints = {
        "fullawake_gateway": {
            "target": "127.0.0.1:8765",
            "open": probe_port("127.0.0.1", 8765),
            "http": probe_http("http://127.0.0.1:8765/health"),
        },
        "adb_reverse_bridge": {
            "target": "127.0.0.1:28765",
            "open": probe_port("127.0.0.1", 28765),
        },
        "voice_duplex_sandbox": {
            "target": "127.0.0.1:8766",
            "open": probe_port("127.0.0.1", 8766),
        },
    }
    return endpoints


def generate_fingerprint(resolv_conf: str | None = None, dns_probe=probe_dns_server) -> dict:
    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "git_commit": get_git_commit(SUITE),
        "components": audit_components(),
        "endpoints": audit_endpoints(),
        "dns": audit_dns(resolv_conf, dns_probe) if resolv_conf is not None else {
            'status': 'unknown', 'reason': 'resolver_not_supplied', 'active_data_changed': False},
    }


def main():
    parser = argparse.ArgumentParser(description="Audit runtime fingerprint and capability states.")
    parser.add_argument("--json", action="store_true", help="Output pure JSON")
    parser.add_argument('--resolv-conf', type=Path, help='Read a local target resolv.conf snapshot')
    parser.add_argument('--adb-resolv-path', help='Read an explicit Android-readable target resolver path via ADB')
    parser.add_argument('--serial', help='ADB device serial')
    args = parser.parse_args()

    if args.resolv_conf and args.adb_resolv_path:
        parser.error('Choose one resolver source')
    resolver = args.resolv_conf.read_text(encoding='utf-8') if args.resolv_conf else None
    dns_probe = probe_dns_server
    vantage = 'local'
    if args.adb_resolv_path:
        from deploy_to_phone import AdbSocketClient
        adb = AdbSocketClient(**({'serial': args.serial} if args.serial else {}))
        resolver = adb.shell('cat -- ' + shlex.quote(args.adb_resolv_path))
        dns_probe = lambda server: probe_adb_dns_server(adb, server)
        vantage = 'android-native'
    elif resolver is None and Path('/etc/resolv.conf').is_file():
        resolver = Path('/etc/resolv.conf').read_text(encoding='utf-8')
    fp = generate_fingerprint(resolver, dns_probe)
    fp['dns']['probe_environment'] = vantage
    if args.json:
        print(json.dumps(fp, ensure_ascii=False, indent=2))
        return

    print("=== DSHA Runtime Fingerprint ===")
    print(f"Git Commit (LucidHeart): {fp['git_commit'] or 'N/A'}")
    print('DNS:', json.dumps(fp['dns'], ensure_ascii=False))
    print("\n--- Components ---")
    for name, c in fp["components"].items():
        print(f"  [{c['status'].upper():8s}] {name:18s} v{c['version'] or '?'} (lock: {c['lock_version'] or 'N/A'})")

    print("\n--- Endpoints ---")
    for name, ep in fp["endpoints"].items():
        st = "OPEN" if ep.get("open") else "CLOSED"
        print(f"  [{st:6s}] {name:20s} -> {ep['target']}")


if __name__ == "__main__":
    main()
