#!/usr/bin/env python3
"""Exercise local-only configuration RPC with target ucode and inert services."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def test(root, qemu):
    files = Path(__file__).resolve().parents[1] / 'feed/wrtmesh/files'
    with tempfile.TemporaryDirectory(prefix='wrtmesh-configuration-') as temporary:
        stage = Path(temporary)
        config, delta = stage / 'config', stage / 'delta'
        config.mkdir()
        delta.mkdir()
        wireless = config / 'wireless'
        wireless.write_text("""
config wifi-iface 'home'
 option mode 'ap'
 option ssid 'Home 日本語'
 option mlo '1'
 list device 'radio0'
 list device 'radio1'
 list device 'radio2'
config wifi-iface 'iot'
 option mode 'ap'
 option ssid 'Home 日本語'
 option device 'radio0'
 option ifname 'iot0'
config wifi-iface 'offline'
 option mode 'ap'
 option ssid 'Disabled AP'
 option device 'radio1'
 option disabled '1'
config wifi-iface 'ambiguous'
 option mode 'ap'
 option ssid 'Ambiguous'
 list device 'radio0'
 list device 'radio1'
config wifi-iface 'station'
 option mode 'sta'
 option ssid 'Upstream'
 option device 'radio2'
""")
        (config / 'network').write_text("# unchanged local network configuration\n")
        (config / 'wrtmesh').write_text("# empty\n")
        (config / 'wrtmesh_peers').write_text("# empty\n")
        unchanged = {name: hashlib.sha256((config / name).read_bytes()).hexdigest()
                     for name in ('wireless', 'network')}
        service = stage / 'service'
        service_log = stage / 'service.log'
        service.write_text('#!' + sys.executable + '\n' + f"""
import sys
from pathlib import Path
assert sys.argv[1:] == ['reload']
log = Path({str(service_log)!r})
with log.open('a') as stream:
    stream.write('reload\\n')
sys.exit(1 if Path({str(stage / 'service-fail')!r}).exists() else 0)
""")
        service.chmod(0o700)
        (stage / 'mesh.uc').write_text(
            (files / 'mesh.uc').read_text()
            .replace('/tmp/wrtmesh-private/mesh', str(stage / 'state'))
            .replace('/tmp/wrtmesh-public/', str(stage / 'public') + '/')
            .replace('/etc/init.d/wrtmesh', str(service))
            .replace('return uci.cursor();', f"return uci.cursor('{config}', '{delta}');"))
        (stage / 'wrtmesh.uc').write_text(
            (files / 'wrtmesh.uc').read_text()
            .replace('/usr/lib/wrtmesh/mesh.uc', str(stage / 'mesh.uc'))
            .replace('/var/lock/wrtmesh-config.lock', str(stage / 'config.lock'))
            .replace("from 'ubus'", f"from '{stage}/ubus.uc'"))
        (stage / 'ubus.uc').write_text(f"""
import {{ readfile }} from 'fs';
export function connect() {{
	return {{
		call: (object, method, args) => {{
			let db = json(readfile('{stage}/bus.json'));
			return db[object + ':' + method] ?? {{}};
		}}
	}};
}}
export function error() {{ return null; }}
""")
        bus = {
            'network.device:status': {'macaddr': '02:00:00:00:00:01'},
            'network.interface.lan:status': {
                'up': True, 'l3_device': 'br-lan.1',
                'ipv4-address': [{'address': '192.168.1.20', 'mask': 24}]},
            'network.wireless:status': {
                'radio0': {'interfaces': [{'section': 'home', 'ifname': 'mlo.ap0'},
                                          {'ifname': 'iot0'},
                                          {'section': 'ambiguous', 'ifname': 'ap.first'}]},
                'radio1': {'interfaces': [{'section': 'home', 'ifname': 'mlo.ap0'},
                                          {'section': 'ambiguous', 'ifname': 'ap.second'}]},
                'radio2': {'interfaces': [{'section': 'home', 'ifname': 'mlo.ap0'}]},
            },
            'hostapd.mlo.ap0:get_status': {
                'status': 'ENABLED', 'ssid': 'Home 日本語', 'bssid': '02:00:00:01:00:00',
                'links': [{'link_id': 0, 'bssid': '02:00:00:01:00:00', 'freq': 2412},
                          {'link_id': 2, 'bssid': '02:00:00:01:00:02', 'freq': 5975}]},
            'hostapd.iot0:get_status': {
                'status': 'ENABLED', 'ssid': 'Home 日本語', 'bssid': '02:00:00:02:00:00'},
        }

        def save_bus():
            (stage / 'bus.json').write_text(json.dumps(bus))

        save_bus()
        command = [qemu, '-L', str(root), str(root / 'usr/bin/ucode'),
                   '-L', str(root / 'usr/lib/ucode/*.so')]

        def execute(script):
            result = subprocess.run(command + ['-e', script], text=True, capture_output=True,
                                    env=os.environ, check=False, timeout=25)
            assert result.returncode == 0, result.stderr
            return result.stdout

        def rpc(method, **args):
            return json.loads(execute(
                f"let api = loadfile('{stage}/wrtmesh.uc', {{raw_mode: true}})().wrtmesh;"
                f"print(api['{method}'].call({{args:{json.dumps(args)}}}));"))

        def uci(script):
            return execute(f"import * as uci from 'uci'; let c=uci.cursor('{config}','{delta}');" + script)

        def save_profile(profile_id, section='iot', enabled=False, interval=30, ttl=180, **extra):
            return rpc('profile_save', id=profile_id, section=section, enabled=enabled,
                       interval=interval, ttl=ttl, **extra)

        def reloads():
            return len(service_log.read_text().splitlines()) if service_log.exists() else 0

        configuration = rpc('configuration')
        networks = {item['section']: item for item in configuration['ssids']}
        assert set(networks) == {'home', 'iot', 'offline', 'ambiguous'}
        assert networks['home']['iface'] == 'mlo.ap0' and networks['home']['mlo']
        assert networks['home']['max_links'] == 3 and len(networks['home']['links']) == 2
        assert networks['iot']['iface'] == 'iot0' and not networks['iot']['mlo']
        assert networks['offline']['reason'] == 'profile_runtime_unavailable'
        assert networks['ambiguous']['reason'] == 'profile_runtime_ambiguous'
        assert configuration['profiles'] == [] and reloads() == 0

        assert save_profile('main', 'home', True) == {'saved': True}
        assert reloads() == 1
        values = json.loads(uci("print(c.get_all('wrtmesh','main'));"))
        assert (values['section'], values['iface'], values['mlo'], values['max_links']) == ('home', 'mlo.ap0', '1', '3')
        assert 'peer' not in values and 'peer_mode' not in values
        assert save_profile('iot') == {'saved': True}
        assert rpc('status')['profiles'] == ['main']
        peer_mac = '02:00:00:00:00:21'
        assert rpc('save', address='192.168.1.21', bridge_mac=peer_mac, name='Peer',
                   profiles={'iot': '02:00:00:03:00:01'}) == {'saved': True}
        assert rpc('save', address='192.168.1.21', bridge_mac=peer_mac, name='Peer',
                   profiles={'iot': '02:00:00:02:00:00'}) == {'error': 'duplicate_bssid'}
        assert save_profile('iot', enabled=True, interval=60, ttl=180) == {'saved': True}

        before = reloads()
        invalid = [
            ({'profile_id': '0bad'}, 'invalid_profile_id'),
            ({'profile_id': 'a' * 49}, 'invalid_profile_id'),
            ({'profile_id': 'invalid', 'interval': 29}, 'invalid_profile_timers'),
            ({'profile_id': 'invalid', 'interval': 301}, 'invalid_profile_timers'),
            ({'profile_id': 'invalid', 'ttl': 179}, 'invalid_profile_timers'),
            ({'profile_id': 'invalid', 'interval': 100, 'ttl': 180}, 'invalid_profile_timers'),
            ({'profile_id': 'invalid', 'section': 'station'}, 'invalid_profile_section'),
            ({'profile_id': 'invalid', 'section': 'ambiguous', 'enabled': True}, 'profile_runtime_ambiguous'),
            ({'profile_id': 'invalid', 'section': 'offline', 'enabled': True}, 'profile_runtime_unavailable'),
            ({'profile_id': 'duplicate', 'section': 'home', 'enabled': True}, 'duplicate_profile_section'),
            ({'profile_id': 'invalid', 'metadata': {'iface': 'iot0', 'mlo': False, 'max_links': 2}},
             'profile_metadata_unsupported'),
            ({'profile_id': 'invalid', 'enabled': True,
              'metadata': {'iface': 'other0', 'mlo': False, 'max_links': 1}}, 'profile_runtime_mismatch'),
        ]
        for arguments, error in invalid:
            assert save_profile(**arguments) == {'error': error}, arguments
        assert reloads() == before

        assert save_profile('off', 'offline') == {'saved': True}
        original_metadata = {key: values[key] for key in ('iface', 'mlo', 'max_links')}
        del bus['hostapd.mlo.ap0:get_status']
        save_bus()
        assert save_profile('main', 'home', False) == {'saved': True}
        after = json.loads(uci("print(c.get_all('wrtmesh','main'));"))
        assert all(after[key] == value for key, value in original_metadata.items())
        assert after['enabled'] == '0'
        assert save_profile('main', 'home', True) == {'error': 'profile_runtime_unavailable'}
        assert any(p['address'] == '192.168.1.21' for p in rpc('status')['peers'])
        peer_approvals = (config / 'wrtmesh_peers').read_bytes()
        assert rpc('profile_remove', id='iot') == {'saved': True}
        assert (config / 'wrtmesh_peers').read_bytes() == peer_approvals

        # Both configs are consumed during reconciliation. A pending change in
        # either one blocks both kinds of RPC mutation.
        for package in ('wrtmesh', 'wrtmesh_peers'):
            uci(f"c.set('{package}','pending','test'); c.save('{package}');")
            before = reloads()
            assert save_profile('blocked') == {'error': 'config_busy'}
            assert rpc('remove', bridge_mac=peer_mac) == {'error': 'config_busy'}
            assert reloads() == before
            (delta / package).unlink()
        with (stage / 'config.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            assert save_profile('locked') == {'error': 'config_busy'}
        (stage / 'service-fail').touch()
        assert save_profile('reload_failure') == {'saved': True, 'error': 'service_reload_failed'}
        assert any(p['id'] == 'reload_failure' for p in rpc('configuration')['profiles'])
        (stage / 'service-fail').unlink()
        assert save_profile('reload_failure') == {'saved': True}

        # Supported old explicit profile settings remain editable even when the
        # radio is absent. Their technical defaults are retained on disable.
        uci("c.set('wrtmesh','main','section','home');"
            "c.set('wrtmesh','main','iface','legacy.ap');"
            "c.set('wrtmesh','main','mlo','1');"
            "c.set('wrtmesh','main','max_links','3');"
            "c.set('wrtmesh','main','enabled','1'); c.commit('wrtmesh');")
        assert save_profile('main', 'home', False) == {'saved': True}
        values = json.loads(uci("print(c.get_all('wrtmesh','main'));"))
        assert values['iface'] == 'legacy.ap' and values['enabled'] == '0'
        assert rpc('profile_remove', id='missing') == {'error': 'profile_not_found'}
        for item in rpc('configuration')['profiles']:
            assert rpc('profile_remove', id=item['id']) == {'saved': True}
        # A historical single-peer profile owns its approvals inside the
        # roaming section. Delete keeps them as a standalone peer in the same
        # UCI commit, and re-add connects that peer to the new fleet worker.
        embedded_mac = '02:00:00:00:00:31'
        uci("c.set('wrtmesh','embedded','roaming');"
            "c.set('wrtmesh','embedded','enabled','0');"
            "c.set('wrtmesh','embedded','section','iot');"
            "c.set('wrtmesh','embedded','iface','iot0');"
            "c.set('wrtmesh','embedded','mlo','0');"
            "c.set('wrtmesh','embedded','max_links','1');"
            "c.set('wrtmesh','embedded','interval','30');"
            "c.set('wrtmesh','embedded','ttl','180');"
            "c.set('wrtmesh','embedded','peer','192.168.1.31');"
            f"c.set('wrtmesh','embedded','peer_mac','{embedded_mac}');"
            "c.set('wrtmesh','embedded','peer_bssid',['02:00:00:03:00:31']);"
            # Force a safe section-name collision at the preferred name.
            "c.set('wrtmesh','peer_020000000031','other'); c.commit('wrtmesh');")
        assert rpc('profile_remove', id='embedded') == {'saved': True}
        dormant = next(peer for peer in rpc('status')['peers'] if peer['bridge_mac'] == embedded_mac)
        assert dormant['profiles'] == {'embedded': ['02:00:00:03:00:31']}
        assert save_profile('embedded', enabled=True) == {'saved': True}
        embedded = json.loads(uci("print(c.get_all('wrtmesh','embedded'));"))
        assert embedded['peer_mode'] == 'fleet' and embedded['peers'] == ['peer_020000000031_1']
        assert rpc('profile_remove', id='embedded') == {'saved': True}
        for index in range(17):
            assert save_profile('p' + str(index)) == {'saved': True}
        assert save_profile('overflow') == {'error': 'profile_limit'}
        assert save_profile('p16') == {'saved': True}
        for name, digest in unchanged.items():
            assert hashlib.sha256((config / name).read_bytes()).hexdigest() == digest
        acl = json.loads((files / 'wrtmesh-acl.json').read_text())['luci-app-wrtmesh']
        assert 'configuration' in acl['read']['ubus']['wrtmesh']
        assert {'profile_save', 'profile_remove'} <= set(acl['write']['ubus']['wrtmesh'])
        assert not {'profile_save', 'profile_remove'} & set(acl['read']['ubus']['wrtmesh'])
        assert set(acl['write']) == {'ubus'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--c7-rootfs', type=Path, required=True)
    parser.add_argument('--qemu', default=shutil.which('qemu-aarch64'))
    args = parser.parse_args()
    if not args.qemu:
        parser.error('qemu-aarch64 is required')
    test(args.c7_rootfs.resolve(), args.qemu)
    print('Local SSID selection, profile validation, reconciliation and ACL fixtures passed.')


if __name__ == '__main__':
    main()
