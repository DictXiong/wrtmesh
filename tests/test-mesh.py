#!/usr/bin/env python3
"""Exercise Mesh collection, peer overrides and the CGI with target ucode and inert data."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def test(root, qemu):
    source = Path(__file__).resolve().parents[1] / 'feed/wrtmesh/files'
    local_mac = '02:00:00:00:00:01'
    legacy_mac = '02:00:00:00:00:21'
    new_mac = '02:00:00:00:00:22'
    station_mac = '02:00:00:00:00:70'
    mld_mac = '02:00:00:00:00:74'
    ap_mld = '02:00:00:00:01:74'
    link0 = {'link_id': 0, 'address': '02:00:00:00:00:75', 'bssid': '02:00:00:00:01:75'}
    link2 = {'link_id': 2, 'address': '02:00:00:00:00:76', 'bssid': '02:00:00:00:01:76'}
    bssid = '02:00:00:00:01:21'

    with tempfile.TemporaryDirectory(prefix='wrtmesh-test-') as temp:
        stage = Path(temp)
        config = stage / 'config'
        delta = stage / 'delta'
        state = stage / 'state'
        for d in (config, delta, state):
            d.mkdir()
        clock = stage / 'uptime'
        clock.write_text('100.00 0.00\n')
        service = stage / 'service'
        service.write_text('#!/bin/sh\n[ "$1" = reload ]\n')
        service.chmod(0o700)
        # Replace curl with a local fixture that honors the relevant curl options
        # and writes its header/body files. The fetch classifier runs unchanged.
        curl = stage / 'curl'
        curl.write_text('#!' + sys.executable + '\n' + f"""
import json, sys
from pathlib import Path
from urllib.parse import urlsplit
args = sys.argv[1:]
url = urlsplit(args[-1])
assert url.scheme == 'http' and url.hostname in ('192.168.1.21', '192.168.1.22')
assert url.path in ('/cgi-bin/wrtmesh', '/cgi-bin/xr-mesh') and url.query in ('', 'identity=1')
with (Path({str(stage)!r}) / 'http-calls.jsonl').open('a') as stream:
    stream.write(json.dumps({{'host': url.hostname, 'path': url.path, 'query': url.query}}) + '\\n')
fixture = Path({str(stage)!r}) / (url.hostname + ('-identity' if url.query else '') +
    ('-legacy' if url.path == '/cgi-bin/xr-mesh' else '') + '.json')
if not fixture.exists():
    response = {{'status': 404, 'data': None}} if url.path == '/cgi-bin/xr-mesh' else None
    if response is None:
        sys.exit(7)
else:
    response = json.loads(fixture.read_text())
status = response['status']
Path(args[args.index('--dump-header') + 1]).write_bytes(f'HTTP/1.1 {{status}} Fixture\\r\\n\\r\\n'.encode())
if status != 200:
    sys.exit(22)
payload = json.dumps(response['data']).encode()
if len(payload) > int(args[args.index('--max-filesize') + 1]):
    sys.exit(63)
Path(args[args.index('--output') + 1]).write_bytes(payload)
""")
        curl.chmod(0o700)
        (config / 'wrtmesh_peers').write_text('# empty\n')
        (config / 'wrtmesh').write_text(f"""
config roaming 'main'
	option enabled '1'
	option peer '192.168.1.21'
	option peer_mac '{legacy_mac}'
	list peer_bssid '{bssid}'
""")
        (stage / 'mesh.uc').write_text(
            (source / 'mesh.uc').read_text()
            .replace('/tmp/wrtmesh-private/mesh', str(state))
            .replace('/etc/config/', str(config) + '/')
            .replace('/tmp/wrtmesh-public/', str(stage / 'public') + '/')
            .replace('/usr/bin/curl', str(curl))
            .replace('/proc/uptime', str(clock))
            .replace('/etc/init.d/wrtmesh', str(service))
            .replace('return uci.cursor();', f"return uci.cursor('{config}', '{delta}');")
        )
        (stage / 'mesh-sample.uc').write_text(
            (source / 'mesh-sample.uc').read_text()
            .replace('/tmp/dhcp.leases', str(stage / 'dhcp.leases'))
        )
        (stage / 'dhcp.leases').write_text(f"0 {link2['address']} 192.168.1.43 example-client *\n")
        for name in ('wrtmesh.uc', 'wrtmesh.cgi', 'readiness.uc'):
            shutil.copyfile(source / name, stage / name)
        for name in ('mesh-sample.uc', 'wrtmesh.uc', 'wrtmesh.cgi'):
            path = stage / name
            path.write_text(path.read_text()
                            .replace('/usr/lib/wrtmesh/mesh.uc', str(stage / 'mesh.uc'))
                            .replace('/usr/lib/wrtmesh/readiness.uc', str(stage / 'readiness.uc'))
                            .replace("from 'ubus'", f"from '{stage}/fixture-ubus.uc'")
                            .replace("from 'rtnl'", f"from '{stage}/fixture-rtnl.uc'")
                            .replace('/etc/config/', str(config) + '/')
                            .replace('/var/lock/wrtmesh-config.lock', str(stage / 'config.lock'))
                            .replace('rtnl.const', 'rtnl.constants'))
        (stage / 'fixture-ubus.uc').write_text(f"""
import {{ readfile, writefile }} from 'fs';
export function connect() {{
	return {{
		list: (pattern) => pattern == null
			? ['network.interface.lan', 'hostapd.ap-iot', 'hostapd.ap-mld0']
			: [{{ get_status: {{}}, get_clients: {{}} }}],
		call: (object, method, args) => {{
			let db = json(readfile('{stage}/bus.json'));
			if (object == 'umdns' && method == 'query') {{
				writefile('{stage}/queries.jsonl', (readfile('{stage}/queries.jsonl') ?? '') + sprintf('%J', args) + '\n');
				return {{}};
			}}
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
            'hostapd.ap-iot:get_status': {'status': 'ENABLED', 'ssid': 'IoT',
                                         'bssid': '02:00:00:00:01:70', 'freq': 2412, 'channel': 1},
            'hostapd.ap-iot:get_clients': {'clients': {
                station_mac: {'assoc': True, 'authorized': True, 'signal': -60,
                              'rate': {'rx': 17200000, 'tx': 144120000}},
                '02:00:00:00:00:71': {'assoc': False, 'authorized': False},
            }},
            'hostapd.ap-mld0:get_status': {
                'status': 'ENABLED', 'ssid': 'Home', 'bssid': link0['bssid'], 'freq': 5180,
                'links': [{'link_id': 0, 'bssid': link0['bssid'], 'freq': 5180},
                          {'link_id': 2, 'bssid': link2['bssid'], 'freq': 5975}],
            },
            'hostapd.ap-mld0:get_clients': {'clients': {
                mld_mac: {'assoc': True, 'authorized': True, 'signal': -53, 'assoc_link_id': 0,
                          'ap_mld_address': ap_mld, 'links': [link0, link2],
                          'rate': {'rx': 17200000, 'tx': 144120000}},
                '02:00:00:00:00:77': {'assoc': True, 'authorized': True, 'signal': -67},
            }},
            'umdns:browse': {'_wrtmesh._tcp': {
                'candidate': {'iface': 'br-lan.1', 'port': 80, 'ipv4': ['192.168.1.22', '192.168.2.1']},
                'other-vlan': {'iface': 'br-guest', 'port': 80, 'ipv4': '192.168.1.23'},
                'pending': {'iface': 'br-lan.1', 'port': 80, 'host': 'wrtmesh-020000000025.local'},
                'wrong-prefix': {'iface': 'br-lan.1', 'port': 80, 'host': 'xr-020000000026.local'},
            }, '_xr-roaming._tcp': {
                'old-candidate': {'iface': 'br-lan.1', 'port': 80, 'ipv4': '192.168.1.23'},
                'same-candidate': {'iface': 'br-lan.1', 'port': 80, 'ipv4': '192.168.1.22'},
                'old-pending': {'iface': 'br-lan.1', 'port': 80, 'host': 'xr-020000000027.local'},
                'wrong-prefix': {'iface': 'br-lan.1', 'port': 80, 'host': 'wrtmesh-020000000028.local'},
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
                f"let rpc = loadfile('{stage}/wrtmesh.uc', {{raw_mode: true}})().wrtmesh;"
                f"print(rpc['{method}'].call({{args: {json.dumps(args)}}}));"
            )
            return json.loads(run(['-e', script]))

        def cgi(remote, method='GET', query='', server='192.168.1.20'):
            response = run([str(stage / 'wrtmesh.cgi')], REQUEST_METHOD=method,
                           QUERY_STRING=query, SERVER_ADDR=server, REMOTE_ADDR=remote)
            head, data = response.split('\n\n', 1)
            return int(head.split()[1]), json.loads(data)

        def reply(address, status=None, data=None):
            fixture = stage / (address + '.json')
            if status is None:
                fixture.unlink(missing_ok=True)
            else:
                fixture.write_text(json.dumps({'status': status, 'data': data}))

        def at(seconds):
            clock.write_text(f'{seconds}.00 0.00\n')

        remote = {'version': 1, 'revision': '11111111-1111-4111-8111-111111111111', 'sample_age': 8,
                  'bridge_mac': legacy_mac, 'name': 'Second AP', 'paths': {},
                  'stations': [{'mac': '02:00:00:00:00:72', 'ssid': 'Home', 'signal': -51,
                                'ipv4': '192.168.1.42', 'ipv6': 'ff02::1', 'rx': 96070000}]}
        assert rpc('status')['peers'][0]['status'] == 'unknown'
        reply('192.168.1.21', 200, remote)
        run([str(stage / 'mesh-sample.uc')])
        data = rpc('status')
        local = {sta['mac']: sta for sta in data['local']['stations']}
        assert len(local) == 3
        station = local[station_mac]
        assert (station['ipv4'], station['ipv6']) == ('192.168.1.41', 'fd00::70')
        assert (station['rx'], station['tx']) == (17200000, 144120000)
        assert (station['freq'], station['channel']) == (2412, 1)
        assert 'mld' not in local['02:00:00:00:00:77'] and 'freq' not in local['02:00:00:00:00:77']
        station = local[mld_mac]
        assert (station['mld'], station['ap_mld'], station['assoc_link_id']) == (mld_mac, ap_mld, 0)
        assert (station['ipv4'], station['name']) == ('192.168.1.43', 'example-client')
        links = {link['id']: link for link in station['links']}
        assert links[0] == {'id': 0, 'mac': link0['address'], 'bssid': link0['bssid'],
                            'freq': 5180, 'channel': 36, 'signal': -53, 'rx': 17200000, 'tx': 144120000}
        assert links[2] == {'id': 2, 'mac': link2['address'], 'bssid': link2['bssid'],
                            'freq': 5975, 'channel': 5}
        assert data['local']['paths'][legacy_mac] == {'bridge': 'br-lan', 'port': 'lan2', 'medium': 'ethernet'}
        assert data['local']['gateway']['port'] == 'lan1'
        station = data['peers'][0]['data']['stations'][0]
        assert data['peers'][0]['online'] and data['peers'][0]['status'] == 'fresh' and station['signal'] == -51
        assert data['peers'][0]['age'] == 8 and data['local_updated_at'] - data['peers'][0]['updated_at'] == 8
        assert (station['ipv4'], station['ipv6'], station['rx']) == ('192.168.1.42', None, 96070000)
        discovery = rpc('discover')
        assert discovery['pending']
        assert sorted(discovery['candidates'], key=lambda peer: peer['address']) == [
            {'address': '192.168.1.22', 'name': 'candidate'},
            {'address': '192.168.1.23', 'name': 'old-candidate'},
        ]
        questions = [json.loads(line)['question'] for line in (stage / 'queries.jsonl').read_text().splitlines()]
        assert questions == ['wrtmesh-020000000025.local', 'xr-020000000027.local']
        assert rpc('scan') == {'scanning': True}
        questions = [json.loads(line)['question'] for line in (stage / 'queries.jsonl').read_text().splitlines()]
        assert questions[-2:] == ['_wrtmesh._tcp.local', '_xr-roaming._tcp.local']
        reply('192.168.1.21-identity', 200, {'version': 1, 'bridge_mac': legacy_mac,
                                           'name': 'Second AP', 'profiles': {'main': [bssid]}})
        assert rpc('identify', address='192.168.1.21')['peer']['profiles'] == {'main': [bssid]}
        assert cgi('192.168.1.21')[1]['sample_age'] == 0 and cgi('192.168.1.22')[0] == 403
        assert cgi('192.168.1.22', query='identity=1')[1]['bridge_mac'] == local_mac
        assert cgi('192.168.2.21', query='identity=1')[0] == 403
        assert cgi('192.168.1.21', server='192.168.10.1')[0] == 403
        assert cgi('192.168.1.21', method='POST')[0] == 405
        assert rpc('save', address='192.168.1.22', bridge_mac=new_mac, name='Node 2',
                   profiles={'main': bssid}) == {'error': 'duplicate_bssid'}
        assert rpc('save', address='192.168.1.22', bridge_mac=new_mac, name='Node 2',
                   profiles={}) == {'saved': True}
        assert cgi('192.168.1.22')[0] == 200
        at(110)
        old_version = {key: value for key, value in remote.items() if key != 'sample_age'}
        reply('192.168.1.22', 200, {**old_version, 'bridge_mac': new_mac, 'stations': []})
        run([str(stage / 'mesh-sample.uc')])
        peers = {peer['bridge_mac']: peer for peer in rpc('status')['peers']}
        assert peers[legacy_mac]['age'] == 18
        assert peers[new_mac]['status'] == 'fresh' and peers[new_mac]['data']['stations'] == []
        assert peers[new_mac]['age'] == 0
        at(189)
        assert cgi('192.168.1.21')[1]['sample_age'] == 79
        run([str(stage / 'mesh-sample.uc')])
        peers = {peer['bridge_mac']: peer for peer in rpc('status')['peers']}
        assert (peers[legacy_mac]['status'], peers[legacy_mac]['age'], peers[legacy_mac]['data']) == ('stale', 97, None)
        assert peers[new_mac]['status'] == 'fresh'
        for http, expected in ((403, 'forbidden'), (None, 'unreachable'), (404, 'unavailable'),
                               (503, 'stale'), (200, 'unavailable')):
            reply('192.168.1.21', http)
            run([str(stage / 'mesh-sample.uc')])
            peer = next(p for p in rpc('status')['peers'] if p['bridge_mac'] == legacy_mac)
            assert peer['status'] == expected and peer['data'] is None
        new_revision = '11111111-1111-4111-8111-111111111112'
        peer_mld = {'mac': mld_mac, 'mld': mld_mac, 'ap_mld': ap_mld, 'ssid': 'Home'}
        reply('192.168.1.21', 200, {**remote, 'revision': new_revision, 'sample_age': 0, 'stations': [
            {**peer_mld, 'links': [links[0]], 'signal': -53},
            {**peer_mld, 'links': [links[2]], 'signal': -57},
        ]})
        run([str(stage / 'mesh-sample.uc')])
        peer = next(p for p in rpc('status')['peers'] if p['bridge_mac'] == legacy_mac)
        assert peer['status'] == 'fresh' and len(peer['data']['stations']) == 1
        assert {link['id'] for link in peer['data']['stations'][0]['links']} == {0, 2}
        many = []
        for index in range(256):
            addr = f'02:10:00:00:00:{index:02x}'
            many.append({**peer_mld, 'mac': addr, 'mld': addr, 'ssid': 'a' * 32, 'name': 'a' * 64,
                         'ipv6': '2001:db8:1234:1234:1234:1234:1234:1234',
                         'links': [{**links[0], 'id': link} for link in range(16)]})
        input_file = stage / 'many.json'
        input_file.write_text(json.dumps({**remote, 'stations': many}))
        size_check = run(['-e', f"""
import * as mesh from '{stage}/mesh.uc';
let sample = mesh.snapshot(mesh.read_json('{input_file}', 1048576), '{legacy_mac}');
let wire = sprintf('%J', sample);
let state = sprintf('%J', {{ seen: 100, data: sample }});
let cache = {{}};
for (let i = 0; i < mesh.limit; i++)
	cache[i] = {{ address: '192.168.1.21', seen: 100, status: 'fresh', data: sample }};
print({{ truncated: sample.truncated, count: length(sample.stations), wire: length(wire),
	local: length(state), cache: length(sprintf('%J', cache)) }});
"""])
        sizes = json.loads(size_check)
        assert sizes['truncated'] and 0 < sizes['count'] < 256
        assert sizes['wire'] < 65536 and sizes['local'] < 65536 and sizes['cache'] < 1048576
        # Compatibility fallback is bounded to the old read-only endpoint and
        # happens only when the canonical endpoint actually answers 404.
        reply('192.168.1.21-legacy', 200, remote)
        for status, expected_paths in ((404, ['/cgi-bin/wrtmesh', '/cgi-bin/xr-mesh']),
                                       (403, ['/cgi-bin/wrtmesh']), (None, ['/cgi-bin/wrtmesh'])):
            reply('192.168.1.21', status)
            (stage / 'http-calls.jsonl').write_text('')
            run(['-e', f"""
import * as mesh from '{stage}/mesh.uc';
let result = mesh.fetch_response({{address:'192.168.1.20', mask:24, device:'br-lan.1'}}, '192.168.1.21', false);
print(result.status);
"""])
            calls = [json.loads(line)['path'] for line in (stage / 'http-calls.jsonl').read_text().splitlines()]
            assert calls == expected_paths
        at(285)
        assert cgi('192.168.1.21')[0] == 503
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
