#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-only
"""Exercise SSID policy boundaries with real target ucode and inert inputs."""

import argparse
import copy
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile


def run_tests(root, qemu):
    source = Path(__file__).resolve().parents[1] / 'feed/wrtmesh/files/mesh.uc'
    vectors = []

    def case(name, function, args, expected, boolean=False):
        vectors.append({'name': name, 'function': function, 'args': args,
                        'expected': expected, 'boolean': boolean})

    for name, value in (
        ('ascii', 'Home'), ('numeric-name', '0'), ('spaces', ' Home '),
        ('unicode', '家庭 网络'), ('quotes', 'a"\\ b'), ('32-bytes', 'a' * 32),
        ('utf8-32-bytes', 'é' * 16),
    ):
        case('ssid-exact-' + name, 'ssid', [value], value)
    for name, value in (
        ('empty', ''), ('33-bytes', 'a' * 33), ('utf8-34-bytes', 'é' * 17),
        ('newline', 'a\nb'), ('nul', 'a\0b'), ('DEL', 'a\x7fb'),
        ('number', 42), ('array', ['Home']), ('null', None),
    ):
        case('ssid-reject-' + name, 'ssid', [value], None)
    case('ssid-list-empty', 'ssid_list', [[]], [])
    names = ['Home', 'home', ' Home', 'Home ', 'é', 'e\u0301']
    case('ssid-list-no-normalization', 'ssid_list', [names], names)
    names = ['network-' + str(i) for i in range(17)]
    case('ssid-list-17', 'ssid_list', [names], names)
    case('ssid-list-reject-18', 'ssid_list', [names + ['extra']], None)
    case('ssid-list-reject-duplicate', 'ssid_list', [['Home', 'Home']], None)
    case('ssid-list-reject-string', 'ssid_list', ['Home'], None)
    case('ssid-list-reject-invalid-entry', 'ssid_list', [['Home', '']], None)

    secure = {'auth': 'psk2', 'cipher': 'ccmp', 'pmf': 0, 'ft': False, 'domain': None}
    fast = {**secure, 'ft': True, 'domain': 'a1b2'}
    case('security-keeps-only-public-fields', 'security',
         [{**secure, 'key': 'do-not-export-this-key', 'password_hash': 'not-public',
           'r0kh': ['sensitive-entry'], 'unexpected': 'do-not-export'}], secure)
    case('security-ignores-domain-without-ft', 'security',
         [{**secure, 'domain': 'a1b2'}], secure)
    case('security-wifi-normalized-without-key', 'wireless_security',
         [{'encryption': 'psk2+ccmp', 'key': 'do-not-export-this-key'}], secure)
    case('security-wifi-ft-public-summary', 'wireless_security',
         [{'encryption': 'sae', 'key': 'do-not-export-this-key', 'ieee80211w': '2',
           'ieee80211r': '1', 'mobility_domain': 'ABcd'}],
         {'auth': 'sae', 'cipher': 'ccmp', 'pmf': 2, 'ft': True, 'domain': 'abcd'})
    for mode in ('sae', 'owe', 'wpa3'):
        case('security-wifi-default-required-pmf-' + mode, 'wireless_security',
             [{'encryption': mode}], {**secure, 'auth': mode, 'pmf': 2})
    case('security-wifi-default-mixed-pmf', 'wireless_security',
         [{'encryption': 'sae-mixed'}], {**secure, 'auth': 'sae-mixed', 'pmf': 1})
    case('security-wifi-cipher-alias', 'wireless_security', [{'encryption': 'psk2+aes'}], secure)
    case('security-wifi-reject-secret-as-cipher', 'wireless_security',
         [{'encryption': 'psk2+do-not-export-secret'}], None)
    for name, value in (
        ('unknown-auth', {**secure, 'auth': 'psk2 password123'}),
        ('secret-in-auth', {**secure, 'auth': 'my-wireless-password'}),
        ('pmf-negative', {**secure, 'pmf': -1}),
        ('pmf-three', {**secure, 'pmf': 3}),
        ('pmf-string', {**secure, 'pmf': '2'}),
        ('ft-string', {**secure, 'ft': '1'}),
        ('bad-domain', {**fast, 'domain': 'a1b2c3'}),
        ('null', None),
    ):
        case('security-reject-' + name, 'security', [value], None)
    case('security-identical', 'same_security', [secure, secure], True, True)
    case('security-mode-mismatch', 'same_security', [secure, {**secure, 'auth': 'sae'}], False, True)
    case('security-pmf-mismatch', 'same_security', [secure, {**secure, 'pmf': 2}], False, True)
    case('security-cipher-mismatch', 'same_security', [secure, {**secure, 'cipher': 'tkip'}], False, True)
    case('security-ft-domain-match', 'same_security', [fast, fast], True, True)
    case('security-ft-domain-mismatch', 'same_security', [fast, {**fast, 'domain': 'a1b3'}], False, True)
    # The public summary does not attempt to prove generated FT keys or domain
    # defaults; only an explicitly known mismatch blocks neighbor exchange.
    case('security-ft-unspecified-domain', 'same_security',
         [{**fast, 'domain': None}, {**fast, 'domain': None}], True, True)
    case('security-invalid-summary', 'same_security', [None, secure], False, True)

    bridge = '02:00:00:00:00:21'
    network = '家庭 Wi-Fi '

    def report(addr, ssid=network, suffix=''):
        return {'bssid': addr, 'ssid': ssid,
                'nr': addr.replace(':', '').lower() + '00000000' + '73' + '24' + '09' + suffix}

    first = report('02:00:00:01:00:01')
    second = report('02:00:00:01:00:02')
    third = report('02:00:00:01:00:03')
    envelope = {'version': 1, 'bridge_mac': bridge, 'ssid': network,
                'revision': '11111111-1111-4111-8111-111111111111', 'reports': [first]}
    case('neighbor-valid-base', 'neighbor_report', [first, network], first)
    tlv = report('02:00:00:01:00:01', suffix='0102aabb')
    case('neighbor-valid-tlv', 'neighbor_report', [tlv, network], tlv)
    case('neighbor-drops-untrusted-fields', 'neighbor_report',
         [{**first, 'command': 'never-run-me', 'key': 'not-public'}, network], first)
    mutations = (
        ('ssid-trim', {**first, 'ssid': network.rstrip()}),
        ('foreign-ssid', {**first, 'ssid': 'Other'}),
        ('multicast', report('03:00:00:01:00:01')),
        ('zero-mac', report('00:00:00:00:00:00')),
        ('nr-bssid', {**first, 'nr': second['nr']}),
        ('nr-invalid-hex', {**first, 'nr': 'g' * 26}),
        ('nr-embedded-nul', {**first, 'nr': first['nr'][:14] + '\0' + first['nr'][15:]}),
        ('nr-odd', {**first, 'nr': first['nr'] + '0'}),
        ('nr-short', {**first, 'nr': first['nr'][:-2]}),
        ('nr-zero-opclass', {**first, 'nr': first['nr'][:20] + '00' + first['nr'][22:]}),
        ('nr-zero-channel', {**first, 'nr': first['nr'][:22] + '00' + first['nr'][24:]}),
        ('nr-truncated-tlv-header', report('02:00:00:01:00:01', suffix='01')),
        ('nr-truncated-tlv-body', report('02:00:00:01:00:01', suffix='0102aa')),
        ('nr-oversized', report('02:00:00:01:00:01', suffix='0000' * 122)),
    )
    for name, value in mutations:
        case('neighbor-reject-' + name, 'neighbor_report', [value, network], None)
    case('envelope-valid', 'report_envelope', [envelope, bridge, network], envelope)
    three = {**envelope, 'reports': [first, second, third]}
    case('envelope-three-links', 'report_envelope', [three, bridge, network], three)
    case('envelope-drops-untrusted-fields', 'report_envelope',
         [{**envelope, 'command': 'never-run-me', 'uci': {'network': 'never-apply'}}, bridge, network],
         envelope)
    for name, value in (
        ('version', {**envelope, 'version': 2}),
        ('bridge', {**envelope, 'bridge_mac': '02:00:00:00:00:22'}),
        ('ssid', {**envelope, 'ssid': network.rstrip()}),
        ('revision', {**envelope, 'revision': 'not-a-generation'}),
        ('revision-nul', {**envelope, 'revision': envelope['revision'] + '\0x'}),
        ('empty', {**envelope, 'reports': []}),
        ('four', {**envelope, 'reports': [first, second, third, report('02:00:00:01:00:04')]}),
        ('duplicate', {**envelope, 'reports': [first, copy.deepcopy(first)]}),
        ('bad-link', {**envelope, 'reports': [first, {**second, 'ssid': 'Other'}]}),
    ):
        case('envelope-reject-' + name, 'report_envelope', [value, bridge, network], None)

    def part(source_id, payload, age=0):
        material = '\n'.join(sorted(row['bssid'] + ':' + row['nr'] for row in payload['reports']))
        return {'source': source_id, 'envelope': payload,
                'digest': hashlib.sha256(material.encode()).hexdigest(), 'age': age, 'ttl': 95}

    first_part = part('remote_home', envelope)
    grouped = {'ssid': network, 'security': secure, 'parts': [first_part]}
    case('roaming-network-valid', 'roaming_network', [grouped, bridge], grouped)
    second_envelope = {**envelope, 'reports': [second]}
    third_envelope = {**envelope, 'reports': [third]}
    split_group = {**grouped, 'parts': [first_part, part('radio5', second_envelope),
                                      part('radio6', third_envelope)]}
    case('roaming-network-separate-slo-radios', 'roaming_network', [split_group, bridge], split_group)
    for name, value in (
        ('missing-security', {**grouped, 'security': None}),
        ('empty-parts', {**grouped, 'parts': []}),
        ('four-parts', {**split_group, 'parts': split_group['parts'] + [part('radio4', envelope)]}),
        ('duplicate-source', {**grouped, 'parts': [first_part, {**first_part, 'age': 1}]}),
        ('duplicate-bssid-across-sources', {**grouped, 'parts': [first_part, part('another_radio', envelope)]}),
        ('bad-source', {**grouped, 'parts': [{**first_part, 'source': '../home'}]}),
        ('bad-digest', {**grouped, 'parts': [{**first_part, 'digest': 'a' * 63}]}),
        ('nul-digest', {**grouped, 'parts': [{**first_part, 'digest': 'a' * 64 + '\0x'}]}),
        ('nul-source', {**grouped, 'parts': [{**first_part, 'source': 'remote_home\0x'}]}),
        ('expired', {**grouped, 'parts': [{**first_part, 'age': 95}]}),
        ('ttl-too-short', {**grouped, 'parts': [{**first_part, 'ttl': 94}]}),
        ('ttl-too-long', {**grouped, 'parts': [{**first_part, 'ttl': 901}]}),
        ('negative-age', {**grouped, 'parts': [{**first_part, 'age': -1}]}),
        ('fractional-age', {**grouped, 'parts': [{**first_part, 'age': 0.5}]}),
        ('string-age', {**grouped, 'parts': [{**first_part, 'age': '0'}]}),
        ('mismatched-ssid', {**grouped, 'ssid': network.rstrip()}),
    ):
        case('roaming-network-reject-' + name, 'roaming_network', [value, bridge], None)
    previous = {'roaming': [grouped]}
    case('roaming-conflict-identical', 'roaming_conflict', [previous, copy.deepcopy(previous)], False, True)
    case('roaming-conflict-age-only', 'roaming_conflict',
         [previous, {'roaming': [{**grouped, 'parts': [{**first_part, 'age': 30}]}]}], False, True)
    case('roaming-conflict-no-previous', 'roaming_conflict', [None, previous], False, True)
    changed_data = part('remote_home', {**envelope, 'reports': [second]})
    case('roaming-conflict-same-generation-changed-bssid', 'roaming_conflict',
         [previous, {'roaming': [{**grouped, 'parts': [changed_data]}]}], True, True)
    case('roaming-conflict-same-generation-changed-digest', 'roaming_conflict',
         [previous, {'roaming': [{**grouped, 'parts': [{**first_part, 'digest': 'f' * 64}]}]}], True, True)
    new_generation = part('remote_home', {**envelope, 'reports': [second],
                                        'revision': '22222222-2222-4222-8222-222222222222'})
    case('roaming-conflict-new-generation-valid-change', 'roaming_conflict',
         [previous, {'roaming': [{**grouped, 'parts': [new_generation]}]}], False, True)
    long_part = {**first_part, 'ttl': 900, 'age': 899}
    long_group = {**grouped, 'parts': [long_part]}
    case('roaming-long-interval-part-valid', 'roaming_network', [long_group, bridge], long_group)
    case('roaming-long-interval-part-expires', 'roaming_network',
         [{**grouped, 'parts': [{**long_part, 'age': 900}]}, bridge], None)
    anchor = {network: {'remote_home': {'revision': envelope['revision'],
                                      'digest': first_part['digest'], 'seen': 100, 'ttl': 95}}}
    case('anchor-preserved-across-omission', 'report_anchors',
         [anchor, {'roaming': []}, 140], {'anchors': anchor, 'valid': True})
    case('anchor-same-generation-cannot-refresh-seen-or-extend-ttl', 'report_anchors',
         [anchor, {'roaming': [{**grouped, 'parts': [{**first_part, 'ttl': 900}]}]}, 220],
         {'anchors': anchor, 'valid': True})
    shorter = {network: {'remote_home': {**anchor[network]['remote_home'], 'ttl': 95}}}
    long_anchor = {network: {'remote_home': {**anchor[network]['remote_home'], 'ttl': 900}}}
    case('anchor-same-generation-can-shorten-ttl', 'report_anchors',
         [long_anchor, {'roaming': [grouped]}, 140], {'anchors': shorter, 'valid': True})

    lan = {'address': '192.168.1.20', 'mask': 24, 'device': 'br-lan.1'}
    peer = {'address': '192.168.1.21', 'bridge_mac': bridge}

    def neighbor(state=2, addr=bridge, address=peer['address'], dev=lan['device']):
        return {'dst': address, 'dev': dev, 'lladdr': addr, 'state': state}

    for name, state in (('reachable', 2), ('stale', 4), ('delay', 8), ('probe', 16),
                        ('noarp', 64), ('permanent', 128)):
        case('binding-valid-' + name, 'peer_binding', [[neighbor(state)], lan, peer], 'verified')
    for name, state in (('none', 0), ('incomplete', 1), ('failed', 32),
                        ('reachable-failed', 34), ('incomplete-reachable', 3), ('string', '2')):
        case('binding-unknown-' + name, 'peer_binding', [[neighbor(state)], lan, peer], 'unknown')
    case('binding-none', 'peer_binding', [[], lan, peer], 'unknown')
    case('binding-wrong-device', 'peer_binding', [[neighbor(dev='br-guest')], lan, peer], 'unknown')
    case('binding-other-ip', 'peer_binding', [[neighbor(address='192.168.1.22')], lan, peer], 'unknown')
    case('binding-mismatched-mac', 'peer_binding',
         [[neighbor(addr='02:00:00:00:00:22')], lan, peer], 'mismatch')
    case('binding-conflicting-usable-rows', 'peer_binding',
         [[neighbor(), neighbor(addr='02:00:00:00:00:22')], lan, peer], 'mismatch')
    case('binding-consistent-duplicate-rows', 'peer_binding',
         [[neighbor(), neighbor(state=4)], lan, peer], 'verified')
    case('binding-unusable-other-row-is-not-evidence', 'peer_binding',
         [[neighbor(), neighbor(state=32, addr='02:00:00:00:00:22')], lan, peer], 'verified')
    case('binding-off-lan', 'peer_binding',
         [[neighbor(address='192.168.2.21')], lan, {**peer, 'address': '192.168.2.21'}], 'unknown')
    case('binding-own-ip', 'peer_binding',
         [[neighbor(address=lan['address'])], lan, {**peer, 'address': lan['address']}], 'unknown')
    case('binding-no-lan', 'peer_binding', [[neighbor()], None, peer], 'unknown')
    case('binding-malformed-nul-mac', 'peer_binding',
         [[neighbor(addr=bridge + '\0x')], lan, peer], 'unknown')
    for function, args in (
        ('mac', [bridge + '\0x']), ('ipv4', ['192.168.1.21\0x']),
        ('dev', ['br-lan\0x']), ('profile', ['home\0x']),
        ('section_id', ['home\0x']), ('label', ['Home\0x', 32]),
    ):
        case('nul-rejected-before-native-use-' + function, function, args, None)

    with tempfile.TemporaryDirectory(prefix='wrtmesh-ssid-policy-') as temporary:
        stage = Path(temporary)
        staged_source = stage / 'mesh.uc'
        staged_source.write_bytes(source.read_bytes())
        (stage / 'cases.json').write_text(json.dumps(vectors))
        script = stage / 'test.uc'
        script.write_text(
            "import * as fs from 'fs';\n"
            f"import * as mesh from '{staged_source}';\n"
            f"let cases = json(fs.readfile('{stage}/cases.json'));\n"
            "print(map(cases, item => {\n"
            "  let value = mesh[item.function](...item.args);\n"
            "  return { name: item.name, value: item.boolean ? !!value : value };\n"
            "}));\n")
        result = subprocess.run(
            [qemu, '-L', str(root), str(root / 'usr/bin/ucode'),
             '-L', str(root / 'usr/lib/ucode/*.so'), str(script)],
            text=True, capture_output=True, check=False, timeout=30)
        assert result.returncode == 0, result.stderr
        values = json.loads(result.stdout)
        assert len(values) == len(vectors)
        for test, value in zip(vectors, values):
            assert test['name'] == value['name']
            assert value['value'] == test['expected'], (
                test['name'], value['value'], test['expected'])
        return {'passed': True, 'scope': 'real target ucode; inert local inputs only',
                'cases': len(vectors),
                'source_sha256': hashlib.sha256(staged_source.read_bytes()).hexdigest(),
                'groups': ['exact SSID bytes and bounds', 'nonsecret security summaries',
                           'strict neighbor-report envelopes and TLVs', 'grouped radio reports and generations',
                           'actual LAN IP/MAC binding']}


def run_status_tests(root, qemu):
    """Check the public status result against independent saved worker evidence."""
    source = Path(__file__).resolve().parents[1] / 'feed/wrtmesh/files/mesh.uc'
    ssid, bridge, peer_address = 'Home 日本語', '02:00:00:00:00:21', '192.168.1.21'
    secure = {'auth': 'psk2', 'cipher': 'ccmp', 'pmf': 0, 'ft': False, 'domain': None}
    profiles = ('local_alpha', 'local_beta')

    def report(addr):
        return {'bssid': addr, 'ssid': ssid, 'nr': addr.replace(':', '') + '00000000732409'}

    def envelope(addr):
        return {'version': 1, 'bridge_mac': bridge, 'ssid': ssid,
                'revision': '11111111-1111-4111-8111-111111111111', 'reports': [report(addr)]}

    parts = []
    for source_id, addr in [('peer_radio_a', '02:00:00:01:00:01'), ('peer_radio_b', '02:00:00:01:00:02')]:
        payload = envelope(addr)
        parts.append({'source': source_id, 'envelope': payload, 'age': 0, 'ttl': 95,
                      'digest': hashlib.sha256((addr + ':' + payload['reports'][0]['nr']).encode()).hexdigest()})
    digest_set = sorted(part['digest'] for part in parts)
    bssid_set = sorted(part['envelope']['reports'][0]['bssid'] for part in parts)
    peer = {'bridge_mac': bridge, 'address': peer_address, 'automatic': True,
            'ssids': [ssid], 'profiles': {}, 'status': 'fresh', 'age': 0, 'updated_at': 1000}
    entry = {'address': peer_address, 'status': 'fresh', 'identity': 'verified', 'seen': 100,
             'revision': '22222222-2222-4222-8222-222222222222',
             'data': {'roaming': [{'ssid': ssid, 'security': secure, 'parts': parts}]},
             'report_seen': {ssid: {part['source']: {'revision': part['envelope']['revision'],
                                                   'digest': part['digest'], 'seen': 100, 'ttl': 95}
                                    for part in parts}}}
    proof = {'address': peer_address, 'bridge_mac': bridge, 'digests': digest_set,
             'bssids': bssid_set, 'applied': True}
    workers = {name: {'version': 3, 'profile': name, 'ssid': ssid, 'sampled_uptime': 100,
                      'interval_seconds': 30, 'state': 'ok', 'reason': 'ok',
                      'own_digest': 'a' * 64, 'applied_peers': [copy.deepcopy(proof)]}
               for name in profiles}
    checked = []
    with tempfile.TemporaryDirectory(prefix='wrtmesh-ssid-status-') as temporary:
        stage = Path(temporary)
        config, delta = stage / 'config', stage / 'delta'
        config.mkdir(); delta.mkdir()
        (config / 'wrtmesh_peers').write_text(
            f"config peer 'p_020000000021'\n option bridge_mac '{bridge}'\n"
            f" option address '{peer_address}'\n option ssid_mode 'auto'\n list roam_ssid '{ssid}'\n")
        roaming_config = ''.join(
            f"config roaming '{name}'\n option section 'radio{index}'\n option enabled '1'\n"
            f" option iface 'ap{index}'\n option mlo '0'\n option max_links '1'\n"
            " option interval '30'\n option ttl '180'\n" for index, name in enumerate(profiles))
        (config / 'wrtmesh').write_text(roaming_config)
        wireless = ''.join(
            f"config wifi-iface 'radio{index}'\n option mode 'ap'\n option ssid '{ssid}'\n"
            f" option device 'radio{index}'\n option encryption 'psk2'\n list network 'lan'\n"
            for index in range(2))
        (config / 'wireless').write_text(wireless)
        staged_source = stage / 'mesh.uc'
        staged_source.write_text(source.read_text()
                                 .replace('/tmp/wrtmesh-private', str(stage / 'private'))
                                 .replace('/tmp/wrtmesh-public', str(stage / 'public')))
        command = [qemu, '-L', str(root), str(root / 'usr/bin/ucode'),
                   '-L', str(root / 'usr/lib/ucode/*.so')]

        def execute(values, status_workers, now=100, peers=None):
            for name in profiles:
                directory = stage / 'private' / ('profile-' + name)
                directory.mkdir(parents=True, exist_ok=True)
                path = directory / 'status.json'
                if name in status_workers:
                    path.write_text(json.dumps(status_workers[name]))
                else:
                    path.unlink(missing_ok=True)
            script = ("import * as uci from 'uci';"
                      f"import * as mesh from '{staged_source}';"
                      f"let c=uci.cursor('{config}','{delta}');"
                      f"print(mesh.roaming_status(c,{json.dumps(peers or [peer])},"
                      f"{json.dumps({bridge: values})},{now},1000));")
            result = subprocess.run(command + ['-e', script], text=True, capture_output=True,
                                    timeout=10, check=False)
            assert result.returncode == 0, result.stderr
            return json.loads(result.stdout)[0]['roaming'][0]

        def expect(name, row, state, reason):
            assert (row['state'], row['reason'], row['local_applied']) == (state, reason, state == 'active'), (name, row)
            checked.append(name)

        expect('different-local-and-remote-ids-two-slo-controllers', execute(entry, workers), 'active', 'ready')
        value = copy.deepcopy(workers)
        value.pop(profiles[1])
        expect('missing-second-controller-cannot-green', execute(entry, value), 'unavailable', 'local_unavailable')
        value = copy.deepcopy(workers)
        value[profiles[1]].update(state='error', reason='apply_write_failed')
        expect('second-controller-apply-failed', execute(entry, value), 'error', 'apply_failed')
        for name, change in (
            ('not-applied', {'applied': False}),
            ('same-count-wrong-digests', {'digests': ['b' * 64, 'c' * 64]}),
            ('missing-one-radio-digest', {'digests': digest_set[:1]}),
            ('same-count-wrong-bssids', {'bssids': ['02:00:00:05:00:01', '02:00:00:05:00:02']}),
        ):
            value = copy.deepcopy(workers)
            value[profiles[1]]['applied_peers'] = [{**proof, **change}]
            expect(name, execute(entry, value), 'pending', 'awaiting_apply')
        value = copy.deepcopy(workers)
        value[profiles[1]]['ssid'] = ssid + ' Other'
        expect('wrong-local-ssid', execute(entry, value), 'unavailable', 'local_unavailable')
        value = copy.deepcopy(workers)
        value[profiles[1]]['sampled_uptime'] = 0
        expect('stale-local-worker', execute(entry, value), 'unavailable', 'local_unavailable')
        value = copy.deepcopy(entry)
        value['identity'] = 'mismatch'
        expect('arp-mismatch-cannot-green', execute(value, workers), 'mismatch', 'identity_mismatch')
        value['identity'] = 'unknown'
        expect('arp-unknown-cannot-green', execute(value, workers), 'pending', 'identity_pending')
        value = copy.deepcopy(entry)
        value['status'] = 'stale'
        expect('outer-snapshot-stale', execute(value, workers), 'stale', 'peer_stale')
        value = copy.deepcopy(entry)
        value['data']['roaming'][0]['security'] = {**secure, 'auth': 'sae'}
        expect('security-mismatch-cannot-green', execute(value, workers), 'mismatch', 'peer_security_mismatch')
        value = copy.deepcopy(entry)
        value['data'].pop('roaming')
        expect('old-peer-has-no-auto-capability', execute(value, workers), 'unsupported', 'peer_upgrade_required')
        value = copy.deepcopy(entry)
        value['data']['roaming'] = []
        expect('peer-has-no-matching-ssid', execute(value, workers), 'pending', 'peer_ssid_missing')
        value = copy.deepcopy(entry)
        value['seen'] = 196
        fresh_workers = copy.deepcopy(workers)
        for worker in fresh_workers.values(): worker['sampled_uptime'] = 196
        expect('outer-heartbeat-cannot-refresh-frozen-radio', execute(value, fresh_workers, now=196), 'stale', 'peer_reports_stale')
        value = copy.deepcopy(entry)
        value['seen'] = 600
        for part in value['data']['roaming'][0]['parts']:
            part.update(ttl=900, age=200)
            value['report_seen'][ssid][part['source']].update(seen=400, ttl=900)
        long_workers = copy.deepcopy(workers)
        for worker in long_workers.values():
            worker.update(sampled_uptime=400, interval_seconds=300)
        (config / 'wrtmesh').write_text(roaming_config.replace("interval '30'", "interval '300'").replace("ttl '180'", "ttl '900'"))
        expect('long-interval-with-fresh-lease', execute(value, long_workers, now=600), 'active', 'ready')
        value['seen'] = 1300
        for part in value['data']['roaming'][0]['parts']: part['age'] = 0
        for worker in long_workers.values(): worker['sampled_uptime'] = 1300
        expect('long-interval-exact-lease-expiry', execute(value, long_workers, now=1300), 'stale', 'peer_reports_stale')
        (config / 'wrtmesh').write_text(roaming_config)
        (config / 'wireless').write_text(wireless.replace("list network 'lan'", "list network 'guest'", 1))
        expect('same-ssid-different-service-network', execute(entry, workers), 'mismatch', 'local_ambiguous')
        (config / 'wireless').write_text(wireless.replace("list network 'lan'", "option network ' lan lan '", 1))
        expect('equivalent-membership-whitespace-and-duplicates', execute(entry, workers), 'active', 'ready')
        blocks = wireless.split("config wifi-iface 'radio1'", 1)
        (config / 'wireless').write_text(blocks[0] + "config wifi-iface 'radio1'\n option disabled '1'" + blocks[1])
        missing_disabled_worker = {profiles[0]: workers[profiles[0]]}
        expect('admin-disabled-band-not-required', execute(entry, missing_disabled_worker), 'active', 'ready')
        (config / 'wireless').write_text(wireless)
        legacy = {**peer, 'automatic': False, 'ssids': [],
                  'profiles': {profiles[0]: [bssid_set[0]], profiles[1]: [bssid_set[1]]}}
        legacy_workers = copy.deepcopy(workers)
        for index, worker in enumerate(legacy_workers.values()):
            worker['applied_peers'] = [{**proof, 'digests': [], 'bssids': [bssid_set[index]]}]
        expect('legacy-pin-applied-subsets', execute(entry, legacy_workers, peers=[legacy]), 'active', 'ready')
        legacy_workers[profiles[1]]['applied_peers'][0]['bssids'] = [bssid_set[1], '02:00:00:09:00:01']
        expect('legacy-pin-forbids-foreign-applied-bssid', execute(entry, legacy_workers, peers=[legacy]), 'pending', 'awaiting_apply')
        # A declarative automatic peer must follow the same cache/ARP/proof
        # path when no LuCI peer override has ever been created.
        execute(entry, workers)

        def declaration(label='_provisioned_node', address=peer_address, mac=bridge,
                        names=(ssid,), mode='auto', disabled=False, pins=False):
            value = (f"\nconfig peer '{label}'\n option bridge_mac '{mac}'\n"
                     f" option address '{address}'\n option name 'Provisioned AP'\n")
            if mode is not None:
                value += f" option ssid_mode '{mode}'\n"
            if disabled:
                value += " option disabled '1'\n"
            for name in names:
                value += f" list roam_ssid '{name}'\n"
            if pins:
                value += f" list {profiles[0]}_bssid '{bssid_set[0]}'\n"
            return value

        def override(address=peer_address, names=(ssid,), *, disabled=False, automatic=True):
            value = (f"config peer 'p_020000000021'\n option bridge_mac '{bridge}'\n"
                     f" option address '{address}'\n option name 'Local override'\n")
            if disabled:
                return value + " option disabled '1'\n"
            if automatic:
                value += " option ssid_mode 'auto'\n"
                for name in names:
                    value += f" list roam_ssid '{name}'\n"
            else:
                value += f" list {profiles[0]}_bssid '{bssid_set[0]}'\n"
            return value

        def inventory(declarations, local='# empty\n', extra_roaming=''):
            (config / 'wrtmesh').write_text(roaming_config + declarations + extra_roaming)
            (config / 'wrtmesh_peers').write_text(local)
            script = ("import * as uci from 'uci';"
                      f"import * as mesh from '{staged_source}';"
                      f"let c=uci.cursor('{config}','{delta}');"
                      "let inventory=mesh.peer_inventory(c,mesh.overrides(c));"
                      f"let cache={json.dumps({bridge: entry})};"
                      f"let plan=mesh.roaming_overlay(c,'{profiles[0]}',100,cache,{{}});"
                      "for (let p in inventory.peers) {p.status='fresh';p.age=0;p.updated_at=1000;}"
                      "print({inventory,plan,peers:mesh.roaming_status(c,inventory.peers,cache,100,1000)});")
            result = subprocess.run(command + ['-e', script], text=True, capture_output=True,
                                    timeout=10, check=False)
            assert result.returncode == 0, result.stderr
            return json.loads(result.stdout)

        value = inventory(declaration())
        assert len(value['peers']) == 1 and value['peers'][0]['automatic']
        assert value['peers'][0]['ssids'] == [ssid] and value['peers'][0]['profiles'] == {}
        assert value['peers'][0]['roaming'][0]['state'] == 'active'
        assert value['plan'][0]['auto'] and value['plan'][0]['disabled'] is False
        assert value['plan'][0]['reason'] == 'ready' and len(value['plan'][0]['parts']) == 2
        checked.append('provisioned-auto-with-empty-luci-overrides-reaches-applied-status')

        value = inventory(declaration(names=()))
        assert len(value['peers']) == 1 and value['peers'][0]['ssids'] == []
        assert value['plan'][0]['disabled'] is True and value['plan'][0]['parts'] == []
        checked.append('provisioned-empty-ssid-policy-preserves-node-but-withdraws-roaming')

        value = inventory(declaration(), override(names=()))
        assert value['peers'][0]['ssids'] == [] and value['plan'][0]['disabled'] is True
        checked.append('luci-empty-selection-overrides-provisioned-auto-policy')
        value = inventory(declaration(), override(address='192.168.1.22'))
        assert value['peers'][0]['address'] == '192.168.1.22'
        assert value['plan'][0]['reason'] != 'ready' and value['plan'][0]['parts'] == []
        checked.append('luci-address-override-cannot-reuse-previous-address-cache')
        value = inventory(declaration(), override(automatic=False))
        assert value['peers'][0]['automatic'] is False
        assert not value['plan'][0].get('auto') and value['plan'][0]['bssids'] == [bssid_set[0]]
        checked.append('explicit-legacy-luci-policy-overrides-provisioned-auto')
        value = inventory(declaration(), override(disabled=True))
        assert value['peers'] == [] and value['plan'][0]['disabled'] is True
        checked.append('luci-tombstone-masks-provisioned-auto-node')

        for name, declarations in (
            ('different-address', declaration() + declaration('duplicate', address='192.168.1.22')),
            ('different-ssid-policy', declaration() + declaration('duplicate', names=('Other SSID',))),
            ('mixed-auto-and-legacy', declaration() + declaration('duplicate', mode=None, pins=True)),
            ('malformed-ssid-list', declaration(names=(ssid, ssid))),
            ('unknown-policy-mode', declaration(mode='invalid', pins=True)),
        ):
            value = inventory(declarations)
            assert value['peers'] == [], (name, value)
            assert value['plan'][0]['disabled'] is True and value['plan'][0]['parts'] == [], (name, value)
            checked.append('conflicting-provisioned-policy-withdraws-' + name)
        value = inventory(declaration() + declaration('identical'))
        assert len(value['peers']) == 1 and value['plan'][0]['reason'] == 'ready'
        checked.append('equivalent-duplicate-provisioned-policy-merges-by-identity')
        value = inventory(declaration() + declaration('duplicate', address='192.168.1.22'), override())
        assert len(value['peers']) == 1 and value['plan'][0]['reason'] == 'ready'
        checked.append('explicit-luci-policy-resolves-conflicting-provisioned-identity')
        other = '02:00:00:00:00:22'
        value = inventory(declaration() + declaration('other', mac=other))
        assert value['peers'] == [] and len(value['plan']) == 2
        assert all(p['disabled'] is True for p in value['plan'])
        checked.append('same-address-different-identities-cannot-bypass-automatic-policy')
        value = inventory(declaration() + declaration('other', mac=other), override(address='192.168.1.22'))
        assert len(value['peers']) == 2
        assert {p['address'] for p in value['peers']} == {peer_address, '192.168.1.22'}
        checked.append('address-override-resolves-cross-identity-address-conflict')
        value = inventory(declaration(disabled=True))
        assert value['peers'] == [] and value['plan'][0]['disabled'] is True
        checked.append('disabled-provisioned-auto-is-a-withdrawal')
        value = inventory(declaration(mode=None, pins=True))
        assert len(value['peers']) == 1 and value['peers'][0]['profiles'] == {profiles[0]: [bssid_set[0]]}
        assert value['plan'] == []
        checked.append('standalone-legacy-pins-remain-outside-automatic-managed-overlay')
        # A historical embedded peer reference is not a second declaration of
        # policy and must not make an explicit automatic declaration fall back.
        embedded = (f"\nconfig roaming 'old_reference'\n option enabled '0'\n"
                    f" option peer '{peer_address}'\n option peer_mac '{bridge}'\n"
                    f" list peer_bssid '{bssid_set[0]}'\n")
        value = inventory(declaration(pins=True), extra_roaming=embedded)
        assert value['peers'][0]['profiles'] == {} and value['plan'][0]['reason'] == 'ready'
        checked.append('automatic-declaration-shields-leftover-legacy-pin-references')
    return checked


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--c7-rootfs', type=Path, required=True)
    parser.add_argument('--qemu', default=shutil.which('qemu-aarch64'))
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if not args.qemu:
        parser.error('qemu-aarch64 is required')
    result = run_tests(args.c7_rootfs.resolve(), args.qemu)
    result['status_cases'] = run_status_tests(args.c7_rootfs.resolve(), args.qemu)
    if args.output:
        args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
