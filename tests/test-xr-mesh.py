#!/usr/bin/env python3
"""Exercise Mesh collection, peer overrides and the CGI with target ucode and inert data."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def test(root, qemu):
    source = Path(__file__).resolve().parents[1] / 'feed/wrtmesh/files'
    local_mac = '02:00:00:00:00:01'
    legacy_mac = '02:00:00:00:00:21'
    new_mac = '02:00:00:00:00:22'
    station_mac = '02:00:00:00:00:70'
    bssid = '02:00:00:00:01:21'

    with tempfile.TemporaryDirectory(prefix='xr-mesh-test-') as temp:
        stage = Path(temp)
        config = stage / 'config'
        delta = stage / 'delta'
        state = stage / 'state'
        for d in (config, delta, state):
            d.mkdir()
        (config / 'xr_mesh').write_text('# empty\n')
        (config / 'xr_roaming').write_text(f"""
config roaming 'main'
	option enabled '1'
	option peer '192.168.1.21'
	option peer_mac '{legacy_mac}'
	list peer_bssid '{bssid}'
""")
        (stage / 'mesh.uc').write_text(
            (source / 'mesh.uc').read_text()
            .replace('/tmp/xr-roaming-private/mesh', str(state))
            .replace('/tmp/xr-roaming-public/', str(stage / 'public') + '/')
            .replace('return uci.cursor();', f"return uci.cursor('{config}', '{delta}');")
        )
        # Substitute the transport at the sampler call site. No live router is queried.
        (stage / 'mesh-sample.uc').write_text(
            (source / 'mesh-sample.uc').read_text()
            .replace('mesh.fetch(lan, p.address, false)', f"mesh.read_json('{stage}/remote.json', 65536)")
        )
        for name in ('xrmesh.uc', 'xr-mesh.cgi'):
            shutil.copyfile(source / name, stage / name)
        for name in ('mesh-sample.uc', 'xrmesh.uc', 'xr-mesh.cgi'):
            path = stage / name
            path.write_text(path.read_text()
                            .replace('/usr/lib/xr-roaming/mesh.uc', str(stage / 'mesh.uc'))
                            .replace("from 'ubus'", f"from '{stage}/fixture-ubus.uc'")
                            .replace("from 'rtnl'", f"from '{stage}/fixture-rtnl.uc'")
                            .replace('rtnl.const', 'rtnl.constants'))
        (stage / 'fixture-ubus.uc').write_text(f"""
import {{ readfile }} from 'fs';
export function connect() {{
	return {{
		list: (pattern) => pattern == null
			? ['network.interface.lan', 'hostapd.ap-mld0']
			: [{{ get_status: {{}}, get_clients: {{}} }}],
		call: (object, method, args) => {{
			let db = json(readfile('{stage}/bus.json'));
			if (object == 'network.device')
				return db.devices[args.name];
			return db[object + ':' + method];
		}}
	}};
}}
export function error() {{ return null; }}
""")
        (stage / 'fixture-rtnl.uc').write_text(f"""
import {{ readfile }} from 'fs';
export const constants = {{ RTM_GETNEIGH: 30, NLM_F_DUMP: 768, AF_INET: 2, AF_INET6: 10, AF_BRIDGE: 7 }};
export function request(cmd, flags, args) {{
	return json(readfile('{stage}/netlink.json'))[sprintf('%d', args.family)];
}}
""")
        interface = {'up': True, 'proto': 'dhcp', 'l3_device': 'br-lan.1',
                     'ipv4-address': [{'address': '192.168.1.20', 'mask': 24}],
                     'route': [{'target': '0.0.0.0', 'mask': 0, 'nexthop': '192.168.1.1'}]}
        bus = {
            'network.interface.lan:status': interface,
            'network.interface:dump': {'interface': [interface]},
            'network.wireless:status': {'radio0': {'interfaces': [{'ifname': 'ap-mld0'}]}},
            'devices': {'br-lan': {'type': 'bridge', 'macaddr': local_mac, 'bridge-members': ['lan1', 'lan2']}},
            'hostapd.ap-mld0:get_status': {'status': 'ENABLED', 'ssid': 'Home'},
            'hostapd.ap-mld0:get_clients': {'clients': {
                station_mac: {'assoc': True, 'authorized': True, 'signal': -60,
                              'rate': {'rx': 17200000, 'tx': 144120000}},
                '02:00:00:00:00:71': {'assoc': False, 'authorized': False},
            }},
            'umdns:browse': {'_xr-roaming._tcp': {
                'candidate': {'iface': 'br-lan.1', 'port': 80, 'ipv4': ['192.168.1.22', '192.168.2.1']},
                'other-vlan': {'iface': 'br-guest', 'port': 80, 'ipv4': '192.168.1.23'},
                'maintenance-alias': {'iface': 'br-lan.1', 'port': 80, 'ipv4': '192.168.250.21',
                                      'txt': ['address=192.168.1.24']},
                'off-link-hint': {'iface': 'br-lan.1', 'port': 80, 'ipv4': '192.168.250.22',
                                  'txt': ['address=192.168.2.24']},
                'ambiguous-hint': {'iface': 'br-lan.1', 'port': 80,
                                   'txt': ['address=192.168.1.25', 'address=192.168.1.26']},
                'wrong-interface-hint': {'iface': 'br-guest', 'port': 80,
                                         'txt': ['address=192.168.1.27']},
                'self-hint': {'iface': 'br-lan.1', 'port': 80, 'txt': ['address=192.168.1.20']},
            }},
        }
        (stage / 'bus.json').write_text(json.dumps(bus))
        (stage / 'netlink.json').write_text(json.dumps({
            '2': [{'dst': '192.168.1.21', 'dev': 'br-lan.1', 'state': 2, 'lladdr': legacy_mac},
                  {'dst': '192.168.1.1', 'dev': 'br-lan.1', 'state': 2, 'lladdr': '02:00:00:00:00:ff'},
                  {'dst': '192.168.1.40', 'dev': 'br-lan.1', 'state': 0x20, 'lladdr': station_mac},
                  {'dst': '192.168.1.41', 'dev': 'br-lan.1', 'state': 2, 'lladdr': station_mac}],
            '10': [{'dst': 'fe80::70', 'dev': 'br-lan.1', 'state': 2, 'lladdr': station_mac},
                   {'dst': 'fd00::70', 'dev': 'br-lan.1', 'state': 2, 'lladdr': station_mac}],
            '7': [{'lladdr': legacy_mac, 'dev': 'lan2', 'master': 'br-lan', 'vlan': 1, 'state': 2},
                  {'lladdr': legacy_mac, 'dev': 'lan1', 'master': 'br-lan', 'vlan': 9, 'state': 2},
                  {'lladdr': '02:00:00:00:00:ff', 'dev': 'lan1', 'master': 'br-lan', 'vlan': 1, 'state': 2}],
        }))
        command = [qemu, '-L', str(root), str(root / 'usr/bin/ucode'),
                   '-L', str(root / 'usr/lib/ucode/*.so')]

        def run(args, **env):
            result = subprocess.run(command + args, text=True, capture_output=True,
                                    env={**os.environ, **env}, check=False, timeout=10)
            assert result.returncode == 0, result.stderr
            return result.stdout

        def rpc(method, **args):
            script = (
                f"let rpc = loadfile('{stage}/xrmesh.uc', {{raw_mode: true}})().xrmesh;"
                f"print(rpc['{method}'].call({{args: {json.dumps(args)}}}));"
            )
            return json.loads(run(['-e', script]))

        def cgi(remote, method='GET', query='', server='192.168.1.20'):
            response = run([str(stage / 'xr-mesh.cgi')], REQUEST_METHOD=method,
                           QUERY_STRING=query, SERVER_ADDR=server, REMOTE_ADDR=remote)
            head, data = response.split('\n\n', 1)
            return int(head.split()[1]), json.loads(data)

        remote = {'version': 1, 'revision': '11111111-1111-4111-8111-111111111111',
                  'bridge_mac': legacy_mac, 'name': 'Second AP', 'paths': {},
                  'stations': [{'mac': '02:00:00:00:00:72', 'ssid': 'Home', 'signal': -51,
                                'ipv4': '192.168.1.42', 'ipv6': 'ff02::1', 'rx': 96070000}]}
        (stage / 'remote.json').write_text(json.dumps(remote))
        run([str(stage / 'mesh-sample.uc')])
        data = rpc('status')
        assert data['local']['stations'][0]['mac'] == station_mac and len(data['local']['stations']) == 1
        station = data['local']['stations'][0]
        assert (station['ipv4'], station['ipv6']) == ('192.168.1.41', 'fd00::70')
        assert (station['rx'], station['tx']) == (17200000, 144120000)
        assert data['local']['paths'][legacy_mac] == {'bridge': 'br-lan', 'port': 'lan2', 'medium': 'ethernet'}
        assert data['local']['gateway']['port'] == 'lan1'
        station = data['peers'][0]['data']['stations'][0]
        assert data['peers'][0]['online'] and station['signal'] == -51
        assert (station['ipv4'], station['ipv6'], station['rx']) == ('192.168.1.42', None, 96070000)
        assert rpc('discover')['candidates'] == [
            {'address': '192.168.1.22', 'name': 'candidate'},
            {'address': '192.168.1.24', 'name': 'maintenance-alias'},
        ]
        assert cgi('192.168.1.21')[0] == 200 and cgi('192.168.1.22')[0] == 403
        assert cgi('192.168.1.22', query='identity=1')[1]['bridge_mac'] == local_mac
        assert cgi('192.168.2.21', query='identity=1')[0] == 403
        assert cgi('192.168.1.21', server='192.168.10.1')[0] == 403
        assert cgi('192.168.1.21', method='POST')[0] == 405
        assert rpc('save', address='192.168.1.22', bridge_mac=new_mac, name='Node 2',
                   profiles={'main': bssid}) == {'error': 'duplicate_bssid'}
        assert rpc('save', address='192.168.1.22', bridge_mac=new_mac, name='Node 2',
                   profiles={}) == {'saved': True}
        assert cgi('192.168.1.22')[0] == 200
        assert rpc('remove', bridge_mac=legacy_mac) == {'saved': True}
        assert cgi('192.168.1.21')[0] == 403
        assert [p['bridge_mac'] for p in rpc('status')['peers']] == [new_mac]
        assert {p['bridge_mac']: p['disabled'] for p in json.loads(run([
            str(stage / 'mesh-sample.uc'), 'roaming', 'main'
        ]))} == {legacy_mac: True, new_mac: False}
        bus['network.interface:dump']['interface'].append({
            'up': True, 'proto': 'pppoe', 'l3_device': 'pppoe-wan',
            'route': [{'target': '0.0.0.0', 'mask': 0, 'nexthop': '198.51.100.1', 'metric': 0}],
        })
        interface['route'][0]['metric'] = 10
        (stage / 'bus.json').write_text(json.dumps(bus))
        run([str(stage / 'mesh-sample.uc')])
        assert rpc('status')['local']['gateway'] is None
        assert rpc('remove', bridge_mac=new_mac) == {'saved': True}
        assert rpc('status')['peers'] == []


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--c7-rootfs', required=True, type=Path)
    parser.add_argument('--qemu', default=shutil.which('qemu-aarch64'))
    args = parser.parse_args()
    if not args.qemu:
        parser.error('qemu-aarch64 is required')
    test(args.c7_rootfs.resolve(), args.qemu)
    print('Mesh runtime, topology, discovery, peer lifecycle and read-only CGI fixtures passed.')


if __name__ == '__main__':
    main()
