#!/usr/bin/env python3
"""Exercise automatic SSID candidates through the real worker; no AP/network I/O."""
from pathlib import Path
import hashlib
import json
import shlex
import shutil

T = Path(__file__).resolve().parent
R = T.parent
namespace = {'__file__': str(T / 'dynamic.py'), '__name__': 'auto_fixture_definitions'}
exec(compile((T / 'dynamic.py').read_text().split('\nfor name,fn in ')[0],
             str(T / 'dynamic.py'), 'exec'), namespace)
Dynamic = namespace['Dynamic']
C7, ROOT, SHELL = namespace['C7'], namespace['ROOT'], namespace['SHELL']
results = []


def check(name, function):
    details = function()
    results.append({'name': name, 'passed': True, 'details': details})
    print(name + ' PASS', flush=True)


def automatic_rotation():
    m = Dynamic(profile='sensor', shell=C7 if ROOT else SHELL)
    try:
        (m.cfgdir / 'wrtmesh_peers').write_text('config peer p_fixture\n')
        overlay = m.p / 'overlay.json'
        fake_ucode = m.bin / 'ucode'
        fake_ucode.write_text('#!/bin/sh\ncat ' + shlex.quote(str(overlay)) + '\n')
        fake_ucode.chmod(0o700)
        m.helper.write_text(m.helper.read_text().replace('/usr/bin/ucode', str(fake_ucode)))
        m.lan.update(proto='static', l3_device='br-lan',
                     **{'ipv4-address': [{'address': '10.24.0.20', 'mask': 24}]})
        m.save_lan()
        envelope = json.loads((m.http / 'sensor.json').read_text())
        entry = {'id': 'p_fixture', 'address': '10.24.0.10',
                 'bridge_mac': envelope['bridge_mac'], 'bssids': [],
                 'auto': True, 'disabled': False, 'reason': 'ready'}

        def publish(tick, *, renew=True, reason='ready', bad_digest=False, ttl=95):
            if renew:
                envelope['revision'] = '11111111-1111-4111-8111-' + f'{tick:012x}'
            canonical = '\n'.join(sorted(row['bssid'] + ':' + row['nr'] for row in envelope['reports']))
            digest = hashlib.sha256(canonical.encode()).hexdigest()
            value = {**entry, 'reason': reason,
                     'revision': '22222222-2222-4222-8222-' + f'{tick:012x}',
                     'parts': [{'source': 'other_node_uses_another_id', 'envelope': envelope,
                                'seen': tick, 'ttl': ttl, 'digest': '0' * 64 if bad_digest else digest}]}
            overlay.write_text(json.dumps([value]))
            return digest

        digest = publish(100)
        status = m.start()
        assert status['state'] == 'ok', status
        assert len(m.table('sensor')) == 1
        assert status['applied_peers'][0]['digests'] == [digest]
        assert status['applied_peers'][0]['bssids'] == [envelope['reports'][0]['bssid']]
        assert not m.curl_log.exists(), 'automatic candidates must reuse the peer snapshot cache'
        shows, writes = m.count('show_neighbor'), m.writes()
        publish(130)
        status = m.step(130, peer=False)
        assert m.count('show_neighbor') == shows and m.writes() == writes
        # New BSSID and real NR generation, while local UCI and topology remain unchanged.
        report = envelope['reports'][0]
        report['bssid'] = '02:bb:02:00:00:01'
        report['nr'] = report['bssid'].replace(':', '') + report['nr'][12:]
        digest = publish(160)
        status = m.step(160, peer=False)
        assert m.table('sensor')[0][0] == report['bssid']
        assert status['applied_peers'][0]['digests'] == [digest]
        assert m.count('show_neighbor') == shows, 'remote rotation must not force a local full NR collection'
        # The receiving observer can keep a frozen publication looking newly sampled.
        # The worker must preserve first-seen age of the unchanged source revision.
        for tick in [190, 220, 250, 280]:
            publish(tick, renew=False)
            status = m.step(tick, peer=False)
        assert m.table('sensor') == [] and status['applied_peers'] == []
        publish(310, renew=False)
        status = m.step(310, peer=False)
        assert m.table('sensor') == [], 'expired publication must not resurrect after cache withdrawal'
        publish(340)
        status = m.step(340, peer=False)
        assert len(m.table('sensor')) == 1 and status['applied_peers']
        for tick, reason in [(370, 'identity_mismatch'), (400, 'reports_unavailable')]:
            publish(tick, reason=reason)
            status = m.step(tick, peer=False)
            assert m.table('sensor') == [] and not status['applied_peers']
        publish(430, bad_digest=True)
        status = m.step(430, peer=False)
        assert m.table('sensor') == [] and not status['applied_peers']
        publish(460)
        status = m.step(460, peer=False)
        assert len(m.table('sensor')) == 1
        # Same revision but changed content is rejected even if its digest is internally correct.
        report['bssid'] = '02:bb:02:00:00:02'
        report['nr'] = report['bssid'].replace(':', '') + report['nr'][12:]
        publish(490, renew=False)
        status = m.step(490, peer=False)
        assert m.table('sensor') == [] and not status['applied_peers']
        # A peer deliberately using a longer source interval remains valid;
        # the observer's own 95-second TTL is independent of publisher cadence.
        publish(520, ttl=900)
        status = m.step(520, peer=False)
        assert len(m.table('sensor')) == 1
        for tick in [550, 700, 1000]:
            publish(tick, renew=False, ttl=900)
            status = m.step(tick, peer=False)
            assert len(m.table('sensor')) == 1 and status['applied_peers']
        # Expiry for one source generation cannot be extended retroactively.
        publish(1030, renew=False, ttl=95)
        status = m.step(1030, peer=False)
        assert m.table('sensor') == []
        publish(1060, renew=False, ttl=900)
        status = m.step(1060, peer=False)
        assert m.table('sensor') == [] and not status['applied_peers']
        publish(1090, ttl=900)
        status = m.step(1090, peer=False)
        assert len(m.table('sensor')) == 1
        assert not m.curl_log.exists()
        # A mixed old pinned peer and automatic peer must not install an
        # ambiguous duplicate BSSID or retain a previous candidate forever.
        m.profiles['sensor'].update(peer_mode='fleet', peers='oldpeer')
        old = json.loads(json.dumps(envelope))
        old['bridge_mac'] = '02:00:00:aa:00:32'
        m.peers['oldpeer'] = {'address': '10.24.0.11', 'bridge_mac': old['bridge_mac'],
                              'sensor_bssid': old['reports'][0]['bssid']}
        (m.http / 'sensor.peer_b.json').write_text(json.dumps(old))
        m.save_multi()
        publish(1120, ttl=900)
        status = m.step(1120, peer=False)
        assert status['reason'] == 'request_failed' and m.table('sensor') == []
        assert status['applied_peers'] == []
        old_report = old['reports'][0]
        old_report['bssid'] = '02:bb:03:00:00:01'
        old_report['nr'] = old_report['bssid'].replace(':', '') + old_report['nr'][12:]
        m.peers['oldpeer']['sensor_bssid'] = old_report['bssid']
        (m.http / 'sensor.peer_b.json').write_text(json.dumps(old))
        m.save_multi()
        publish(1150, ttl=900)
        status = m.step(1150, peer=False)
        assert len(m.table('sensor')) == 2 and len(status['applied_peers']) == 2
        legacy_proof = next(item for item in status['applied_peers'] if item['bridge_mac'] == old['bridge_mac'])
        assert legacy_proof['bssids'] == [old_report['bssid']] and legacy_proof['digests'] == []
        # An apply failure must not present stale success proof for new data.
        ubus, real = m.bin / 'ubus', m.bin / 'ubus-real'
        shutil.copy2(ubus, real)
        failure = m.p / 'fail-apply'
        ubus.write_text('#!/bin/sh\ncase "$*" in *rrm_nr_set*) [ ! -e ' + shlex.quote(str(failure)) +
                        ' ] || exit 1;; esac\nexec ' + shlex.quote(str(real)) + ' "$@"\n')
        failure.touch()
        report['bssid'] = '02:bb:02:00:00:03'
        report['nr'] = report['bssid'].replace(':', '') + report['nr'][12:]
        publish(1180, ttl=900)
        status = m.step(1180, peer=False)
        assert status['state'] == 'error' and status['reason'] == 'apply_write_failed'
        assert status['applied_peers'] == []
        failure.unlink()
        publish(1210, ttl=900)
        status = m.step(1210, peer=False)
        assert len(m.table('sensor')) == 2 and len(status['applied_peers']) == 2
        return {'different_local_remote_ids': True, 'no_extra_http': True,
                'BSSID_rotation_without_local_collect': True, 'frozen_source_expires': True,
                'no_expired_resurrection': True, 'identity_and_digest_fail_closed': True,
                'same_revision_payload_conflict_rejected': True,
                'long_source_interval_supported': True, 'source_TTL_cannot_extend_same_revision': True,
                'mixed_auto_legacy_collision_clears_old_table': True,
                'legacy_applied_proof': True, 'failed_apply_has_no_success_proof': True,
                'target_C7': bool(ROOT)}
    finally:
        m.close()


def legacy_single_proof():
    m = Dynamic(profile='sensor', shell=C7 if ROOT else SHELL)
    try:
        m.call()
        proof = m.view()['applied_peers']
        assert len(proof) == 1
        assert proof[0]['address'] == '10.24.0.1'
        assert proof[0]['bridge_mac'] == '02:00:00:00:00:03'
        assert proof[0]['bssids'] == m.meta['sensor']['remote'] and proof[0]['digests'] == []
        return {'single_peer_legacy_applied_proof': True, 'target_C7': bool(ROOT)}
    finally:
        m.close()


def provisioned_automatic_without_overrides():
    m = Dynamic(profile='sensor', shell=C7 if ROOT else SHELL)
    try:
        # This is the actual new producer layout: the worker does not carry
        # peer_mode, peers, peer, peer_mac or any manually approved BSSID.
        for key in ['peer', 'peer_mac', 'peer_bssid', 'peer_mode', 'peers']:
            m.profiles['sensor'].pop(key, None)
        m.save_multi()
        (m.cfgdir / 'wrtmesh_peers').write_text('# no LuCI overrides\n')
        m.lan.update(proto='static', l3_device='br-lan',
                     **{'ipv4-address': [{'address': '10.24.0.20', 'mask': 24}]})
        m.save_lan()
        native = m.p / 'native-config'
        native.mkdir()
        (native / 'wrtmesh_peers').write_text('# no LuCI overrides\n')
        (native / 'wireless').write_text("config wifi-iface 'ssid_sensor'\n option mode 'ap'\n option ssid 'ESS-sensor'\n option encryption 'psk2'\n option network 'lan'\n")
        roaming = "config roaming 'sensor'\n option section 'ssid_sensor'\n option enabled '1'\n option iface 'ap-xf00abc12'\n option mlo '0'\n option max_links '1'\n option interval '30'\n option ttl '180'\n"
        (native / 'wrtmesh').write_text(roaming)
        cache = m.p / 'mesh-cache'
        cache.mkdir()
        plan = m.p / 'managed-fallback.json'
        plan.write_text('[]')
        ucode = m.bin / 'ucode'
        if ROOT:
            module = m.p / 'actual-mesh.uc'
            module.write_text((namespace['S'] / 'mesh.uc').read_text()
                              .replace('/tmp/wrtmesh-private/mesh', str(cache))
                              .replace('/tmp/wrtmesh-public/', str(m.public) + '/')
                              .replace('/proc/uptime', str(m.clock))
                              .replace('return uci.cursor();', f"return uci.cursor('{native}','{m.deltadir}');"))
            sampler = m.p / 'actual-mesh-sample.uc'
            sampler.write_text((namespace['S'] / 'mesh-sample.uc').read_text()
                               .replace('/usr/lib/wrtmesh/mesh.uc', str(module)))
            command = [namespace['QEMU'], '-L', str(ROOT), str(ROOT / 'usr/bin/ucode'),
                       '-L', str(ROOT / 'usr/lib/ucode/*.so'), str(sampler)]
            ucode.write_text('#!/bin/sh\nshift\nexec ' + shlex.join(command) + ' "$@"\n')
        else:
            ucode.write_text('#!/bin/sh\ncat ' + shlex.quote(str(plan)) + '\n')
        ucode.chmod(0o700)
        m.helper.write_text(m.helper.read_text().replace('/usr/bin/ucode', str(ucode)))
        m.call()
        assert m.view()['state'] == 'ok'
        assert m.table('sensor') == [] and m.pub('sensor').is_file()
        assert json.loads((m.state_path('sensor') / 'config.json').read_text())['peers'] == []

        envelope = json.loads((m.http / 'sensor.json').read_text())
        peer = {'address': '10.24.0.10', 'bridge_mac': envelope['bridge_mac'],
                'ssid_mode': 'auto', 'roam_ssid': ['ESS-sensor']}
        m.peers['_producer_node'] = peer
        m.save_multi()
        (native / 'wrtmesh').write_text(roaming + "\nconfig peer '_producer_node'\n option address '10.24.0.10'\n option bridge_mac '" + peer['bridge_mac'] + "'\n option ssid_mode 'auto'\n list roam_ssid 'ESS-sensor'\n")
        digest = hashlib.sha256('\n'.join(sorted(row['bssid'] + ':' + row['nr'] for row in envelope['reports'])).encode()).hexdigest()
        part = {'source': 'remote_different_id', 'envelope': envelope, 'digest': digest, 'age': 0, 'ttl': 95}
        value = {peer['bridge_mac']: {'address': peer['address'], 'identity': 'verified',
                 'seen': 100, 'status': 'fresh', 'revision': '22222222-2222-4222-8222-222222222222',
                 'data': {'roaming': [{'ssid': 'ESS-sensor', 'security': {'auth': 'psk2', 'cipher': 'ccmp', 'pmf': 0, 'ft': False, 'domain': None}, 'parts': [part]}]}}}
        (cache / 'peers.json').write_text(json.dumps(value))
        managed = {'id': 'p_' + peer['bridge_mac'].replace(':', ''), 'address': peer['address'],
                   'bridge_mac': peer['bridge_mac'], 'auto': True, 'disabled': False, 'bssids': [],
                   'reason': 'ready', 'revision': value[peer['bridge_mac']]['revision'],
                   'parts': [{**part, 'seen': 100}]}
        plan.write_text(json.dumps([managed]))
        m.at(100)
        m.call()
        status = m.view()
        assert status['state'] == 'ok' and len(m.table('sensor')) == 1, status
        assert status['applied_peers'][0]['digests'] == [digest]
        assert not m.curl_log.exists(), 'declarative policy must reuse the same cached exchange'
        assert (m.cfgdir / 'wrtmesh_peers').read_text() == '# no LuCI overrides\n'

        # The native backend applies a GUI tombstone over the declaration.
        (native / 'wrtmesh_peers').write_text("config peer '" + managed['id'] + "'\n option bridge_mac '" + peer['bridge_mac'] + "'\n option disabled '1'\n")
        plan.write_text(json.dumps([{**managed, 'disabled': True, 'parts': []}]))
        m.at(130)
        m.call()
        assert m.table('sensor') == [] and m.view()['applied_peers'] == []
        # Removing the declared peer returns to a valid single-node worker.
        m.peers.clear()
        m.save_multi()
        (native / 'wrtmesh').write_text(roaming)
        m.at(160)
        m.call()
        assert m.view()['state'] == 'ok' and m.pub('sensor').is_file()
        assert m.table('sensor') == [] and not m.curl_log.exists()
        return {'empty_overrides_declarative_auto_applies': True,
                'worker_has_no_manual_peer_or_pins': True, 'single_node_is_valid': True,
                'luci_tombstone_withdraws_declared_peer': True, 'no_extra_http': True,
                'actual_target_backend_and_worker': bool(ROOT), 'target_C7': bool(ROOT)}
    finally:
        m.close()


check('automatic_SSID_cache_rotation_expiry_and_applied_proof', automatic_rotation)
check('legacy_single_peer_application_evidence', legacy_single_proof)
check('declarative_SSID_policy_without_LuCI_overrides', provisioned_automatic_without_overrides)
(R / 'autossid-tests-result.json').write_text(json.dumps({'passed': True, 'results': results}, indent=2) + '\n')
