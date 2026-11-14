#!/usr/bin/env python3
"""Test only the read-only readiness assessment and RPC with inert transports."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile


def test(root, qemu, work_dir):
    source = Path(__file__).resolve().parents[1]
    files = source / 'feed/wrtmesh/files'
    results = []
    with tempfile.TemporaryDirectory(prefix='readiness-', dir=work_dir) as directory:
        stage = Path(directory)
        command = [qemu, '-L', str(root), str(root / 'usr/bin/ucode'),
                   '-L', str(root / 'usr/lib/ucode/*.so')]
        module = stage / 'readiness.uc'
        module.write_text((files / 'readiness.uc').read_text())
        fixture = stage / 'fixture.json'
        mock = stage / 'transport.uc'
        mock.write_text("""
import { readfile } from 'fs';
export const fixture = json(readfile('""" + str(fixture) + """'));
export const calls = [];
export function cursor() {
 return { foreach: (package, kind, callback) => {
  if (fixture.config_error) die('configuration unavailable');
  if (fixture.config_null) return null;
  for (let section in fixture.sections ?? []) callback(section);
  return length(fixture.sections ?? []) > 0;
 } };
}
export function connect() {
 return {
  call: (object, method, args) => {
   push(calls, [object, method]);
   if (!(object == 'network.wireless' && method == 'status') &&
       !(substr(object, 0, 8) == 'hostapd.' && method == 'get_status'))
    die('forbidden readiness transport');
   let response = fixture.calls?.[object + ':' + method];
   if (response?.throw) die('permission denied');
   return response;
  },
  list: object => {
   push(calls, [object, '@list']);
   let response = fixture.methods?.[object];
   if (response?.throw) die('permission denied');
   return response;
  }
 };
}
""")
        runner = stage / 'run.uc'
        runner.write_text("import * as r from '" + str(module) + "';\n"
                          "import * as t from '" + str(mock) + "';\n"
                          "let result = r.collect(t.cursor(), t.connect(), t.fixture.sample, 100, t.fixture.ownership);\n"
                          "print({ result, calls: t.calls });\n")
        secret = 'NEVER_RETURN_FAKE_PSK_OR_R0KH'
        config = {'.name': 'blue', 'mode': 'ap', 'ssid': 'Same 日本語',
                  'device': ['radio-blue', 'radio-green'], 'ieee80211k': '1',
                  'rrm_neighbor_report': '0', 'key': secret, 'r0kh': secret}
        runtime = {'radio-blue': {'interfaces': [{'section': 'blue', 'ifname': 'wlanBlue'}]}}
        status = {'status': 'ENABLED', 'ssid': config['ssid'], 'bssid': '02:00:00:00:00:01',
                  'rrm': {'neighbor_report_tx': 1}, 'eap': True}
        signatures = [{'get_status': {}, 'rrm_nr_set': {'list': 'Array'},
                       'rrm_beacon_req': {}, 'bss_transition_request': {}}]
        initial = {'sections': [config, {'.name': 'station', 'mode': 'sta', 'key': secret}],
                   'calls': {'network.wireless:status': runtime, 'hostapd.wlanBlue:get_status': status},
                   'methods': {'hostapd.wlanBlue': signatures}}

        def execute(data, script=runner):
            fixture.write_text(json.dumps(data))
            result = subprocess.run(command + [str(script)], capture_output=True, text=True, timeout=15)
            assert result.returncode == 0, result.stderr
            assert secret not in result.stdout
            value = json.loads(result.stdout)
            for obj, method in value['calls']:
                assert (obj == 'network.wireless' and method == 'status') or (
                    obj.startswith('hostapd.') and method in ('get_status', '@list'))
            return value['result']

        def fresh():
            return json.loads(json.dumps(initial))

        def interface(data):
            return execute(data)['aps'][0]['interfaces'][0]

        answer = execute(fresh())
        assert len(answer['aps']) == 1
        ap = answer['aps'][0]
        assert ap['section'] == 'blue' and ap['ssid'] == config['ssid'] and ap['mode'] == 'ap'
        assert ap['device'] == ['radio-blue', 'radio-green'] and ap['devices'] == ap['device']
        assert ap['configuration']['nr'] is False and ap['configuration']['beacon'] is True
        assert ap['configuration']['rrm_beacon_report'] is None
        assert ap['ownership'] == 'unknown'
        assert ap['interfaces'][0]['capabilities'] == {'nr_api': 'supported', 'beacon_api': 'supported', 'btm_api': 'supported'}
        assert all(value['state'] == 'unknown' for value in ap['interfaces'][0]['runtime'].values())
        results.append('whitelist_AP_only_binding_and_config_defaults_no_eap_or_counter_inference')

        data = fresh(); data['sections'][0] = {'.name': 'blue', 'mode': 'ap', 'ssid': config['ssid'], 'device': 'radio-blue radio-green'}
        ap = execute(data)['aps'][0]
        assert ap['configuration']['nr'] is False and ap['configuration']['beacon'] is False
        assert ap['device'] == 'radio-blue radio-green' and ap['devices'] == ['radio-blue', 'radio-green']
        data['sections'][0]['ieee80211k'] = 'nonsense'
        assert execute(data)['aps'][0]['configuration']['nr'] is None
        data['sections'][0]['rrm_neighbor_report'] = '1'
        assert execute(data)['aps'][0]['configuration']['nr'] is True
        results.append('explicit_NR_overrides_and_unset_K_defaults_config_only')

        for response, expected in [([{'get_status': {}}], 'unsupported'), (None, 'unknown'),
                                   ([], 'unknown'), ({'throw': True}, 'unknown')]:
            data = fresh(); data['methods']['hostapd.wlanBlue'] = response
            assert interface(data)['capabilities']['nr_api'] == expected
        results.append('successful_missing_method_vs_absent_or_denied_enumeration')

        data = fresh(); data['calls']['hostapd.wlanBlue:get_status'].update(
            rrm_neighbor_report=False, rrm_beacon_report=True, bss_transition=1, ieee80211r=True)
        observed = interface(data)['runtime']
        assert observed['nr'] == {'state': 'disabled', 'source': 'explicit_status'}
        assert observed['beacon']['state'] == observed['btm']['state'] == observed['ft']['state'] == 'enabled'
        data['calls']['hostapd.wlanBlue:get_status']['status'] = 'DISABLED'
        assert all(v['state'] == 'unknown' for v in interface(data)['runtime'].values())
        results.append('explicit_runtime_flags_only_on_matching_enabled_AP')

        nr = '02000000000100000000510600'
        sample = {'seen': 95, 'data': {'roaming': [{'ssid': config['ssid'], 'parts': [
            {'age': 5, 'ttl': 95, 'digest': 'a' * 64, 'envelope': {
                'version': 1, 'ssid': config['ssid'], 'reports': [
                    {'bssid': '02:00:00:00:00:01', 'ssid': config['ssid'], 'nr': nr}]}}]}]}}
        data = fresh(); data['sample'] = sample
        assert interface(data)['runtime']['nr'] == {'state': 'enabled', 'source': 'cached_neighbor_report'}
        for variant in ('snapshot_stale', 'report_stale', 'wrong_ssid', 'wrong_bssid', 'malformed_NR'):
            data = fresh(); data['sample'] = json.loads(json.dumps(sample))
            part = data['sample']['data']['roaming'][0]['parts'][0]
            if variant == 'snapshot_stale': data['sample']['seen'] = 5
            elif variant == 'report_stale': part['age'] = 90
            elif variant == 'wrong_ssid': data['sample']['data']['roaming'][0]['ssid'] = 'Other'
            elif variant == 'wrong_bssid': data['calls']['hostapd.wlanBlue:get_status']['bssid'] = '02:00:00:00:00:02'
            else: part['envelope']['reports'][0]['nr'] += '01'
            assert interface(data)['runtime']['nr']['state'] == 'unknown', variant
        data = fresh(); data['sample'] = sample; data['calls']['hostapd.wlanBlue:get_status']['rrm_neighbor_report'] = False
        assert interface(data)['runtime']['nr']['state'] == 'disabled'
        results.append('fresh_existing_NR_cache_binds_SSID_BSSID_and_expires_without_overriding_explicit_false')

        data = fresh(); data['sections'].append({'.name': 'red', 'mode': 'ap', 'ssid': config['ssid'], 'ifname': 'otherAP'})
        data['calls']['network.wireless:status']['radio-red'] = {'interfaces': [{'ifname': 'otherAP'}]}
        data['methods']['hostapd.otherAP'] = [{'get_status': {}}]
        data['calls']['hostapd.otherAP:get_status'] = {'throw': True}
        aps = execute(data)['aps']
        assert len(aps) == 2 and aps[1]['interfaces'][0]['mapping'] == 'explicit_ifname'
        assert aps[1]['interfaces'][0]['runtime']['nr']['state'] == 'unknown'
        data['sections'][2].pop('ifname')
        assert execute(data)['aps'][1]['interfaces'] == []
        data = fresh(); data['calls']['network.wireless:status'] = {'throw': True}
        assert execute(data)['aps'][0]['interfaces'] == []
        data = fresh(); data['config_error'] = True
        assert execute(data) == {'version': 1, 'error': 'configuration_unavailable', 'aps': []}
        data = fresh(); data['config_null'] = True
        assert execute(data) == {'version': 1, 'error': 'configuration_unavailable', 'aps': []}
        data = fresh(); data['sections'] = []
        assert execute(data) == {'version': 1, 'aps': []}
        results.append('section_or_exact_ifname_only_no_duplicate_SSID_or_naming_guess')

        # Exercise only the actual new RPC handler, using fake UCI and ubus modules.
        fake_mesh = stage / 'mesh.uc'
        fake_mesh.write_text("import * as t from '" + str(mock) + "';\n"
                             "export function cursor() { return t.cursor(); }\n"
                             "export function uptime() { return 100; }\n"
                             "export function read_json() { return t.fixture.sample; }\n"
                             "export const state = '/unused-inert-state';\n"
                             "export const response_limit = 65536;\n")
        wireless_file = stage / 'wireless'
        api = stage / 'wrtmesh.uc'
        api.write_text((files / 'wrtmesh.uc').read_text()
                       .replace("from 'ubus'", "from '" + str(mock) + "'")
                       .replace('/usr/lib/wrtmesh/mesh.uc', str(fake_mesh))
                       .replace('/usr/lib/wrtmesh/readiness.uc', str(module))
                       .replace('/etc/config/wireless', str(wireless_file)))
        handler = stage / 'handler.uc'
        handler.write_text("import * as t from '" + str(mock) + "';\n"
                           "let api = loadfile('" + str(api) + "', {raw_mode:true})().wrtmesh;\n"
                           "print({result:api.readiness.call(), calls:t.calls});\n")
        wireless_file.write_text('# inert metadata fixture\n'); wireless_file.chmod(0o600)
        assert execute(fresh(), handler)['aps'][0]['ownership'] == 'ordinary'
        wireless_file.chmod(0o444)
        assert execute(fresh(), handler)['aps'][0]['ownership'] == 'readonly'
        wireless_file.chmod(0o600); wireless_file.unlink()
        target = stage / 'target'; target.write_text('# inert target\n'); target.chmod(0o444)
        wireless_file.symlink_to(target)
        assert execute(fresh(), handler)['aps'][0]['ownership'] == 'readonly'
        target.chmod(0o600)
        assert execute(fresh(), handler)['aps'][0]['ownership'] == 'unknown'
        target.unlink()
        assert execute(fresh(), handler)['aps'][0]['ownership'] == 'unknown'
        results.append('actual_readiness_handler_with_mock_transport_and_metadata_only_ownership')

        acl = json.loads((files / 'wrtmesh-acl.json').read_text())['luci-app-wrtmesh']
        assert 'readiness' in acl['read']['ubus']['wrtmesh'] and 'readiness' not in acl['write']['ubus']['wrtmesh']
        assert set(acl['read']) == {'ubus'} and set(acl['write']) == {'ubus'}
        assert './files/readiness.uc $(1)/usr/lib/wrtmesh/' in (source / 'feed/wrtmesh/Makefile').read_text()
        results.append('read_only_ACL_and_module_install_rule')
    return {'passed': True, 'scope': 'new readiness pure assessment and actual handler; inert local transport/config fixtures only',
            'groups': results, 'device_access': False, 'service_actions': False,
            'allowed_transport': ['network.wireless.status', 'hostapd.<mapped iface>.get_status', 'exact hostapd method signatures']}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--qemu', default='qemu-aarch64')
    parser.add_argument('--work-dir', type=Path, required=True)
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    args.work_dir.mkdir(parents=True, exist_ok=True)
    result = test(args.root, args.qemu, args.work_dir)
    text = json.dumps(result, indent=2) + '\n'
    if args.report:
        args.report.write_text(text)
    print(text, end='')


if __name__ == '__main__':
    main()
