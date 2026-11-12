// SPDX-License-Identifier: GPL-2.0-only
'use strict';

import * as fs from 'fs';
import * as uci from 'uci';

export const state = '/tmp/wrtmesh-private/mesh';
export const ttl = 95;
export const limit = 15;
export const response_limit = 65536;
export const cache_limit = 1048576;
export const service = '_wrtmesh._tcp';

export function clean_string(value) {
	return type(value) == 'string' && index(value, '\x00') < 0;
}

export function mac(s) {
	if (!clean_string(s) || length(s) != 17)
		return null;
	s = lc(s);
	return match(s, /^[0-9a-f][02468ace](:[0-9a-f]{2}){5}$/) &&
		s != '00:00:00:00:00:00' ? s : null;
}

export function ipv4(s) {
	if (!clean_string(s) || !match(s, /^(0|[1-9][0-9]{0,2})(\.(0|[1-9][0-9]{0,2})){3}$/))
		return null;
	let parts = map(split(s, '.'), part => int(part));
	if (filter(parts, n => n > 255)[0] != null)
		return null;
	return parts;
}

export function private_ip(s) {
	let a = ipv4(s);
	return a && a[3] > 0 && a[3] < 255 &&
		(a[0] == 10 || (a[0] == 172 && a[1] >= 16 && a[1] <= 31) ||
		 (a[0] == 192 && a[1] == 168));
}

export function on_lan(lan, address) {
	if (!lan || address == lan.address || !private_ip(address))
		return false;
	let a = ipv4(lan.address), b = ipv4(address), bits = lan.mask;
	let source = ((a[0] * 256 + a[1]) * 256 + a[2]) * 256 + a[3];
	let target = ((b[0] * 256 + b[1]) * 256 + b[2]) * 256 + b[3];
	let size = 1 << (32 - bits);
	let host = target % size;
	return int(source / size) == int(target / size) && host > 0 && host < size - 1;
}

export function dev(s) {
	return clean_string(s) && match(s, /^[a-zA-Z0-9_.-]{1,15}$/) ? s : null;
}

export function profile(s) {
	return clean_string(s) && match(s, /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/) ? s : null;
}

export function label(s, max) {
	return clean_string(s) && length(s) <= max && !match(s, /[[:cntrl:]]/) ? s : null;
}

export function array(value) {
	return type(value) == 'array' ? value : [];
}

export function pins(raw) {
	let entries = type(raw) == 'string' ? filter(split(trim(raw), /[[:space:],]+/), length) : array(raw);
	if (!length(entries) || length(entries) > 3)
		return null;
	let list = [];
	for (let entry in entries) {
		let addr = mac(entry);
		if (!addr || index(list, addr) >= 0)
			return null;
		push(list, addr);
	}
	return list;
}

// These values are exact SSID bytes represented by ucode strings. Never trim,
// case-fold or derive cross-node identity from a local UCI section name.
export function ssid(value) {
	return label(value, 32) && length(value) > 0 ? value : null;
}

export function ssid_list(raw) {
	if (type(raw) != 'array' || length(raw) > 17)
		return null;
	let result = [];
	for (let item in raw) {
		if (!ssid(item) || index(result, item) >= 0)
			return null;
		push(result, item);
	}
	return result;
}

function option_number(value) {
	return clean_string(value) && match(value, /^(0|[1-9][0-9]{0,9})$/) ? int(value) : null;
}


export function security(raw) {
	if (type(raw) != 'object' ||
	    index(['none', 'owe', 'psk', 'psk2', 'psk-mixed', 'sae', 'sae-mixed',
	           'wpa', 'wpa2', 'wpa-mixed', 'wpa3', 'wpa3-mixed', 'wpa3-192'], raw.auth) < 0 ||
	    type(raw.pmf) != 'int' || raw.pmf < 0 || raw.pmf > 2 || type(raw.ft) != 'bool' ||
	    (raw.domain != null && (!clean_string(raw.domain) || !match(raw.domain, /^[0-9a-f]{4}$/))))
		return null;
	let cipher = raw.cipher ?? (raw.auth == 'none' ? 'none' : 'ccmp');
	if (index(['none', 'ccmp', 'tkip', 'ccmp+tkip', 'ccmp256', 'gcmp', 'gcmp256'], cipher) < 0)
		return null;
	return { auth: raw.auth, cipher, pmf: raw.pmf, ft: raw.ft, domain: raw.ft ? raw.domain : null };
}

export function wireless_security(section) {
	let pieces = type(section.encryption) == 'string' ? split(section.encryption, '+') : ['none'];
	let auth = pieces[0];
	if (auth == 'psk3') auth = 'sae';
	if (auth == 'psk3-mixed') auth = 'sae-mixed';
	let cipher = auth == 'none' ? 'none' : auth == 'wpa3-192' ? 'gcmp256' : 'ccmp';
	if (length(pieces) > 1) {
		let selected = sort(map(slice(pieces, 1), item => item == 'aes' ? 'ccmp' : item));
		cipher = join('+', selected);
	}
	let default_pmf = index(['sae', 'owe', 'wpa3', 'wpa3-192'], auth) >= 0 ? '2' :
		index(['sae-mixed', 'wpa3-mixed'], auth) >= 0 ? '1' : '0';
	let pmf = option_number(section.ieee80211w ?? default_pmf);
	let ft = section.ieee80211r == '1';
	let domain = type(section.mobility_domain) == 'string' ? lc(section.mobility_domain) : null;
	return security({ auth, cipher, pmf, ft, domain });
}

export function same_security(left, right) {
	left = security(left); right = security(right);
	return left && right && left.auth == right.auth && left.cipher == right.cipher && left.pmf == right.pmf &&
		left.ft == right.ft && (!left.ft || !left.domain || !right.domain || left.domain == right.domain);
}

function uuid(value) {
	return clean_string(value) && match(value, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
}

export function neighbor_report(raw, network) {
	let bssid = mac(raw?.bssid), nr = raw?.nr;
	if (!bssid || raw.ssid != network || !clean_string(nr) ||
	    length(nr) < 26 || length(nr) > 510 || !match(nr, /^[0-9a-f]+$/) || length(nr) % 2 ||
	    substr(nr, 0, 12) != replace(bssid, /:/g, '') ||
	    int(substr(nr, 20, 2), 16) == 0 || int(substr(nr, 22, 2), 16) == 0)
		return null;
	let offset = 26;
	while (offset < length(nr)) {
		if (length(nr) - offset < 4)
			return null;
		let size = int(substr(nr, offset + 2, 2), 16);
		offset += 4 + size * 2;
		if (offset > length(nr))
			return null;
	}
	return { bssid, ssid: network, nr };
}

export function report_envelope(raw, addr, network) {
	if (raw?.version != 1 || raw.bridge_mac != addr || raw.ssid != network ||
	    !uuid(raw.revision) || type(raw.reports) != 'array' ||
	    length(raw.reports) < 1 || length(raw.reports) > 3)
		return null;
	let reports = [], seen = {};
	for (let item in raw.reports) {
		let row = neighbor_report(item, network);
		if (!row || seen[row.bssid])
			return null;
		seen[row.bssid] = true;
		push(reports, row);
	}
	return { version: 1, bridge_mac: addr, ssid: network, revision: raw.revision, reports };
}

export function peer_binding(rows, lan, peer) {
	if (!on_lan(lan, peer.address))
		return 'unknown';
	let addresses = {};
	for (let row in array(rows)) {
		if (row?.dst == peer.address && row.dev == lan.device &&
		    type(row.state) == 'int' && (row.state & 0xde) && !(row.state & 0x21)) {
			let address = mac(row.lladdr);
			if (address)
				addresses[address] = true;
		}
	}
	let found = keys(addresses);
	return length(found) == 0 ? 'unknown' :
		length(found) == 1 && found[0] == peer.bridge_mac ? 'verified' : 'mismatch';
}

export function profile_state(id) {
	if (!profile(id))
		return null;
	return '/tmp/wrtmesh-private' + (id == 'main' ? '' :
		index(['guest', 'iot', 'battalion'], id) >= 0 ? '/' + id : '/profile-' + id);
}

export function uptime() {
	return int(fs.readfile('/proc/uptime', 32));
}

export function read_json(path, max) {
	let data = fs.readfile(path, max + 1);
	if (!data || length(data) > max)
		return null;
	try {
		return json(data);
	} catch (e) {
		return null;
	}
}

export function call(bus, object, method, args) {
	return bus?.call(object, method, args ?? {}) ?? {};
}

export function lan_status(bus) {
	let info = call(bus, 'network.interface.lan', 'status');
	let address = info['ipv4-address']?.[0];
	let device = dev(info.l3_device);
	if (!info.up || !device || !private_ip(address?.address) ||
	    type(address.mask) != 'int' || address.mask < 1 || address.mask > 30)
		return null;
	return { address: address.address, mask: address.mask, device, info };
}

export function identity(bus) {
	let addr = mac(call(bus, 'network.device', 'status', { name: 'br-lan' }).macaddr);
	let hostname = trim(fs.readfile('/proc/sys/kernel/hostname', 64) ?? '');
	return { bridge_mac: addr, name: label(hostname, 64) || 'OpenWrt' };
}

export function peer_key(addr) {
	return 'p_' + replace(addr, /:/g, '');
}

export function profiles(cursor, include_disabled) {
	let result = {};
	cursor.foreach('wrtmesh', 'roaming', s => {
		if ((include_disabled || s.enabled == '1') && profile(s['.name']))
			result[s['.name']] = true;
	});
	return result;
}

export function section_id(value) {
	return clean_string(value) && match(value, /^[A-Za-z0-9_]{1,64}$/) ? value : null;
}

export function profile_metadata(iface, mlo, max_links) {
	return clean_string(iface) && match(iface, /^[A-Za-z][A-Za-z0-9_.-]{0,14}$/) &&
		type(mlo) == 'bool' && type(max_links) == 'int' && max_links >= 1 && max_links <= 3 &&
		(mlo || max_links == 1) ? { iface, mlo, max_links } : null;
}

export function profile_timers(interval, ttl) {
	return type(interval) == 'int' && interval >= 30 && interval <= 300 &&
		type(ttl) == 'int' && ttl >= 180 && ttl <= 1800 && ttl >= interval * 3;
}


function network_membership(raw) {
	let names = {};
	for (let name in type(raw) == 'string' ? split(raw, /[[:space:]]+/) : array(raw))
		if (type(name) == 'string' && length(name)) names[name] = true;
	return sort(keys(names));
}

function section_disabled(cursor, section) {
	if (section.disabled == '1') return true;
	let devices = type(section.device) == 'string' ? filter(split(section.device, /[[:space:]]+/), length) : array(section.device);
	return length(devices) && length(filter(devices, name => cursor.get('wireless', name, 'disabled') != '1')) == 0;
}

export function local_ssids(cursor, bus) {
	let runtime = call(bus, 'network.wireless', 'status');
	let sections = {}, status_cache = {}, result = [];
	for (let radio, data in runtime) {
		for (let item in array(data.interfaces)) {
			let name = section_id(item.section);
			if (name) {
				sections[name] ??= [];
				push(sections[name], { radio, ifname: item.ifname });
			}
		}
	}
	cursor.foreach('wireless', 'wifi-iface', s => {
		if (s.mode != 'ap')
			return;
		let section = s['.name'], ssid = label(s.ssid, 32) ?? '';
		let configured_devices = type(s.device) == 'string' ? split(s.device, /[[:space:]]+/) : array(s.device);
		let devices = filter(configured_devices, dev);
		let entries = sections[section] ?? [];
		// Older netifd status can omit section. An explicit configured interface
		// still identifies it without guessing from a duplicated SSID.
		if (!length(entries) && dev(s.ifname)) {
			for (let radio, data in runtime)
				for (let item in array(data.interfaces))
					if (item.ifname == s.ifname)
						push(entries, { radio, ifname: item.ifname });
		}
		let bases = {};
		for (let item in entries) {
			let parts = type(item.ifname) == 'string' ? match(item.ifname, /^(.+)_link([0-9]{1,2})$/) : null;
			let iface = dev(parts ? parts[1] : item.ifname);
			if (iface)
				bases[iface] = true;
		}
		let names = keys(bases), iface = length(names) == 1 ? names[0] : null;
		let status = iface ? status_cache[iface] ??= call(bus, 'hostapd.' + iface, 'get_status') : {};
		let available = status.status == 'ENABLED';
		let mlo = type(status.links) == 'array';
		let links = [];
		for (let link in slice(array(status.links), 0, 16)) {
			if (type(link.link_id) == 'int' && link.link_id >= 0 && link.link_id <= 15 && mac(link.bssid))
				push(links, { id: link.link_id, bssid: mac(link.bssid),
					freq: type(link.freq) == 'int' ? link.freq : null });
		}
		let max_links = mlo ? max(length(devices), length(links), 1) : 1;
		let metadata = profile_metadata(iface, mlo, max_links);
		let reason = !section_id(section) || !length(ssid) ? 'invalid_profile_section' :
			length(names) > 1 ? 'profile_runtime_ambiguous' :
			section_disabled(cursor, s) || !available ? 'profile_runtime_unavailable' :
			status.ssid != ssid || (s.mlo == '1' && !mlo) ? 'profile_runtime_mismatch' :
			!metadata ? 'profile_metadata_unsupported' : null;
		push(result, { section, ssid, devices, disabled: !!section_disabled(cursor, s), available,
			supported: reason == null, reason, iface, mlo, max_links, links,
			bssid: mac(status.bssid) ?? mac(s.macaddr), security: wireless_security(s),
			service_network: network_membership(s.network) });
	});
	return result;
}

export function local_profiles(cursor, ssids) {
	let result = [];
	let legacy = {
		main: { iface: 'ap-mld1', mlo: true, max_links: 3 },
		battalion: { iface: 'ap-mld0', mlo: true, max_links: 2 },
		guest: { iface: 'ap-mld2', mlo: true, max_links: 2 },
		iot: { iface: 'phy0.0-ap1', mlo: false, max_links: 1 }
	};
	cursor.foreach('wrtmesh', 'roaming', s => {
		let id = s['.name'], section = s.section ?? '', selected;
		let old = !s.mlo && !s.max_links ? legacy[id] : null;
		let metadata = old ? profile_metadata(s.iface || old.iface, old.mlo, old.max_links) :
			index(['0', '1'], s.mlo) >= 0 ? profile_metadata(s.iface, s.mlo == '1', option_number(s.max_links)) : null;
		if (old && metadata?.iface != old.iface)
			metadata = null;
		for (let item in ssids)
			if (item.section == section)
				selected = item;
		if (!section && id == 'main' && old) {
			let matches = filter(ssids, item => item.ssid == s.ssid && item.iface == metadata?.iface);
			if (length(matches) == 1)
				selected = matches[0];
		}
		let interval = option_number(s.interval), ttl = option_number(s.ttl);
		let reason = !profile(id) ? 'invalid_profile_id' :
			index(['', '0', '1'], s.enabled ?? '') < 0 ? 'invalid_profile_enabled' :
			!profile_timers(interval, ttl) ? 'invalid_profile_timers' :
			!metadata ? 'profile_metadata_unsupported' :
			!selected ? 'invalid_profile_section' :
			selected.reason ??
			(metadata.iface != selected.iface || metadata.mlo != selected.mlo ||
			 metadata.max_links < selected.max_links ? 'profile_runtime_mismatch' : null);
		push(result, { id, enabled: s.enabled == '1', section: selected?.section ?? section,
			ssid: selected?.ssid ?? label(s.ssid, 32), iface: metadata?.iface ?? s.iface ?? '',
			mlo: metadata?.mlo, max_links: metadata?.max_links,
			interval: interval ?? 30, ttl: ttl ?? 180, available: selected?.available ?? false,
			supported: reason == null, reason, legacy: !!old });
	});
	let controllers = {};
	for (let item in result)
		if (item.enabled && item.iface) {
			if (controllers[item.iface]) {
				item.supported = controllers[item.iface].supported = false;
				item.reason = controllers[item.iface].reason = 'duplicate_profile_section';
			} else {
				controllers[item.iface] = item;
			}
		}
	return result;
}

// Several non-MLO BSSes may represent one ESS on different radios. Only a
// matching local service network and security summary allow that grouping.
export function local_networks(cursor, bus) {
	let ssids = local_ssids(cursor, bus);
	let configured = local_profiles(cursor, ssids);
	ssids = filter(ssids, item => !item.disabled || !length(filter(ssids, other => other.ssid == item.ssid && !other.disabled)));
	let groups = {}, result = [];
	for (let item in ssids) {
		let token = sprintf('%J', [item.service_network, item.security]);
		let group = groups[item.ssid] ??= { ssid: item.ssid, section: item.section,
			sections: [], members: [], profiles: [], token, ambiguous: false };
		group.ambiguous ||= group.token != token;
		push(group.sections, item.section);
		push(group.members, item);
		for (let profile in configured)
			if (profile.section == item.section)
				push(group.profiles, profile);
	}
	for (let group in values(groups)) {
		let controllers = {}, available = true, supported = true, selected = true, max_links = 0;
		for (let item in group.members) {
			available &&= item.available;
			max_links += item.max_links;
			supported &&= item.supported && item.security != null;
			if (item.iface)
				controllers[item.iface] = true;
			selected &&= length(filter(group.profiles, p => p.section == item.section && p.enabled)) > 0;
		}
		let first = group.members[0], configured = group.profiles[0];
		push(result, { ssid: group.ssid, section: group.section, sections: group.sections,
			members: group.members, profiles: group.profiles, enabled: selected,
			available, supported: supported && !group.ambiguous,
			reason: group.ambiguous ? 'local_ambiguous' :
				!first.security ? 'local_security_unknown' :
				!available ? 'local_unavailable' : !supported ? 'local_unavailable' : null,
			security: first.security, mlo: length(group.members) == 1 && first.mlo,
			max_links: min(3, max_links),
			interval: configured?.interval ?? 30, ttl: configured?.ttl ?? 180 });
	}
	return result;
}

export function configured_networks(cursor) {
	let networks = {}, by_section = {}, active_names = {};
	cursor.foreach('wireless', 'wifi-iface', s => {
		if (s.mode == 'ap' && ssid(s.ssid) && !section_disabled(cursor, s)) active_names[s.ssid] = true;
	});
	cursor.foreach('wireless', 'wifi-iface', s => {
		if (s.mode != 'ap' || !ssid(s.ssid) || (active_names[s.ssid] && section_disabled(cursor, s)))
			return;
		let mode = wireless_security(s);
		let members = network_membership(s.network);
		let token = sprintf('%J', [members, mode]);
		let item = networks[s.ssid] ??= { ssid: s.ssid, sections: [], profiles: [],
			security: mode, token, ambiguous: false };
		item.ambiguous ||= item.token != token;
		push(item.sections, s['.name']);
		by_section[s['.name']] = item;
	});
	cursor.foreach('wrtmesh', 'roaming', s => {
		let item = by_section[s.section];
		if (!item && s['.name'] == 'main' && ssid(s.ssid))
			item = networks[s.ssid];
		if (item && profile(s['.name']))
			push(item.profiles, { id: s['.name'], section: s.section, enabled: s.enabled == '1',
				iface: s.iface, interval: option_number(s.interval) ?? 30, ttl: option_number(s.ttl) ?? 180 });
	});
	return values(networks);
}

export function worker_status(id, now) {
	let directory = profile_state(id);
	let value = directory ? read_json(directory + '/status.json', 65536) : null;
	let elapsed = type(value?.sampled_uptime) == 'int' ? now - value.sampled_uptime : null;
	if (value?.version != 3 || value.profile != id || elapsed == null || elapsed < 0 ||
	    type(value.interval_seconds) != 'int' || value.interval_seconds < 30 ||
	    value.interval_seconds > 300 || elapsed >= value.interval_seconds * 3 ||
	    index(['ok', 'degraded'], value.state) < 0)
		return null;
	return value;
}

export function local_roaming(cursor, bus, addr, now) {
	let result = [];
	for (let network in local_networks(cursor, bus)) {
		if (!network.enabled || !network.supported)
			continue;
		let parts = [], reports = {}, valid = true;
		for (let p in network.profiles) {
			if (!p.enabled)
				continue;
			let status = worker_status(p.id, now);
			let envelope = report_envelope(read_json('/tmp/wrtmesh-public/' +
				(p.id == 'main' ? '' : p.id + '/') + 'own.json', 16384), addr, network.ssid);
			if (!status || status.ssid != network.ssid || !envelope ||
			    !clean_string(status.own_digest) || !match(status.own_digest, /^[0-9a-f]{64}$/)) {
				valid = false;
				break;
			}
			for (let report in envelope.reports) {
				if (reports[report.bssid])
					valid = false;
				reports[report.bssid] = true;
			}
			push(parts, { source: p.id, envelope, digest: status.own_digest,
				age: now - status.sampled_uptime, ttl: max(ttl, min(900, status.interval_seconds * 3)) });
		}
		if (valid && length(parts) && length(reports) <= 3)
			push(result, { ssid: network.ssid, security: network.security, parts });
	}
	return result;
}

export function roaming_network(raw, addr) {
	let network = ssid(raw?.ssid), mode = security(raw?.security);
	if (!network || !mode || type(raw.parts) != 'array' || length(raw.parts) < 1 || length(raw.parts) > 3)
		return null;
	let parts = [], bssids = {}, sources = {};
	for (let item in raw.parts) {
		let envelope = report_envelope(item?.envelope, addr, network);
		if (!profile(item?.source) || sources[item.source] || !envelope ||
		    !clean_string(item.digest) || !match(item.digest, /^[0-9a-f]{64}$/) ||
		    type(item.ttl ?? ttl) != 'int' || (item.ttl ?? ttl) < ttl || (item.ttl ?? ttl) > 900 ||
		    type(item.age) != 'int' || item.age < 0 || item.age >= (item.ttl ?? ttl))
			return null;
		sources[item.source] = true;
		for (let report in envelope.reports) {
			if (bssids[report.bssid])
				return null;
			bssids[report.bssid] = true;
		}
		push(parts, { source: item.source, envelope, digest: item.digest, age: item.age, ttl: item.ttl ?? ttl });
	}
	return length(bssids) <= 3 ? { ssid: network, security: mode, parts } : null;
}

export function reconcile() {
	try {
		return system(['/etc/init.d/wrtmesh', 'reload'], 20000) == 0;
	} catch (e) {
		return false;
	}
}

export function overrides(cursor) {
	let result = {};
	cursor.foreach('wrtmesh_peers', 'peer', s => {
		let addr = mac(s.bridge_mac);
		if (!addr || s['.name'] != peer_key(addr))
			return;
		let p = { bridge_mac: addr, address: s.address, name: label(s.name, 64) || '',
			disabled: s.disabled == '1', profiles: {}, automatic: s.ssid_mode == 'auto',
			ssids: ssid_list(type(s.roam_ssid) == 'string' ? [s.roam_ssid] : s.roam_ssid ?? []) ?? [] };
		for (let option, raw in s) {
			let m = match(option, /^([a-zA-Z][a-zA-Z0-9_]{0,47})_bssid$/);
			let list = m ? pins(raw) : null;
			if (list)
				p.profiles[m[1]] = list;
		}
		result[addr] = p;
	});
	return result;
}

export function peer_inventory(cursor, overlay) {
	let provisioned = {}, legacy = {}, conflicts = {};
	cursor.foreach('wrtmesh', 'peer', s => { provisioned[s['.name']] = s; });
	for (let id, p in provisioned) {
		let addr = mac(p.bridge_mac);
		if (!addr || !private_ip(p.address))
			continue;
		if (legacy[addr] && legacy[addr].address != p.address)
			conflicts[addr] = true;
		legacy[addr] ??= { bridge_mac: addr, address: p.address, name: label(p.name, 64) ?? '', profiles: {} };
		for (let option, raw in p) {
			let m = match(option, /^([A-Za-z][A-Za-z0-9_]{0,47})_bssid$/);
			let list = m ? pins(raw) : null;
			if (list)
				legacy[addr].profiles[m[1]] = list;
		}
	}
	cursor.foreach('wrtmesh', 'roaming', s => {
		let id = s['.name'];
		if (!profile(id))
			return;
		let ids = type(s.peers) == 'string' ? split(s.peers, /[[:space:]]+/) : array(s.peers);
		let sources = s.peer_mode == 'fleet' ? map(ids, i => provisioned[i]) :
			[{ address: s.peer, bridge_mac: s.peer_mac, [id + '_bssid']: s.peer_bssid }];
		for (let p in sources) {
			let addr = mac(p?.bridge_mac), list = pins(p?.[id + '_bssid']);
			if (!addr || !private_ip(p.address) || !list)
				continue;
			legacy[addr] ??= { bridge_mac: addr, address: p.address, name: '', profiles: {} };
			if (legacy[addr].address != p.address)
				conflicts[addr] = true;
			legacy[addr].profiles[id] = list;
		}
	});
	let effective = { ...legacy, ...overlay };
	let peers = filter(values(effective), p => !p.disabled && private_ip(p.address) &&
		(!conflicts[p.bridge_mac] || overlay[p.bridge_mac]));
	return { legacy, peers };
}

export function selected_ssids(peer, networks) {
	if (peer.automatic)
		return peer.ssids ?? [];
	let result = [];
	for (let item in networks)
		if (length(filter(item.profiles, p => length(peer.profiles[p.id] ?? []))))
			push(result, item.ssid);
	return result;
}

export function advertised_profiles(cursor, addr, any_local_identity) {
	let result = {};
	for (let id in keys(profiles(cursor))) {
		let path = '/tmp/wrtmesh-public/' + (id == 'main' ? '' : id + '/') + 'own.json';
		let own = read_json(path, 16384);
		if (own?.version != 1 || (!any_local_identity && own.bridge_mac != addr) || !array(own.reports)[0])
			continue;
		let list = pins(map(own.reports, r => r?.bssid));
		if (list)
			result[id] = list;
	}
	return result;
}


// No ubus/hostapd sampling on the worker cache-reader path.
export function local_profile_bssids_from_public(cursor) {
	return advertised_profiles(cursor, null, true);
}


export function roaming_overlay(cursor, id, now, existing_cache, known_own) {
	let networks = configured_networks(cursor), target;
	for (let network in networks)
		if (length(filter(network.profiles, p => p.id == id)))
			target = network;
	let overlays = overrides(cursor);
	let cache = existing_cache ?? read_json(state + '/peers.json', cache_limit) ?? {};
	let own = {};
	for (let names in values(known_own ?? local_profile_bssids_from_public(cursor)))
		for (let address in names)
			own[address] = true;
	let result = [];
	for (let addr, p in overlays) {
		if (!p.automatic) {
			push(result, { id: peer_key(addr), bridge_mac: addr, address: p.address,
				bssids: p.profiles[id] ?? [], disabled: p.disabled });
			continue;
		}
		let selected = target && index(p.ssids, target.ssid) >= 0;
		let item = { id: peer_key(addr), address: p.address, bridge_mac: addr,
			auto: true, disabled: p.disabled || !selected, bssids: [], reason: 'not_selected', parts: [] };
		if (item.disabled) {
			push(result, item);
			continue;
		}
		let entry = cache[addr]?.address == p.address ? cache[addr] : null;
		let elapsed = type(entry?.seen) == 'int' && now >= entry.seen ? now - entry.seen : null;
		item.revision = entry?.revision;
		item.reason = target.ambiguous ? 'local_ambiguous' : !target.security ? 'local_security_unknown' :
			entry?.identity == 'mismatch' ? 'identity_mismatch' : entry?.identity != 'verified' ? 'identity_pending' :
			!entry ? 'peer_unavailable' : entry.status == 'unreachable' ? 'peer_unreachable' :
			entry.status == 'forbidden' ? 'peer_forbidden' :
			entry.status != 'fresh' ? 'peer_' + (entry.status == 'stale' ? 'stale' : 'unavailable') :
			elapsed == null || elapsed >= ttl ? 'peer_stale' :
			entry.data?.roaming == null ? 'peer_upgrade_required' : 'ready';
		if (item.reason == 'ready') {
			let matches = filter(entry.data.roaming, network => network.ssid == target.ssid);
			let network = matches[0];
			if (length(matches) > 1)
				item.reason = 'peer_ambiguous';
			else if (!network)
				item.reason = 'peer_ssid_missing';
			else if (!same_security(target.security, network.security))
				item.reason = 'peer_security_mismatch';
			else {
				for (let part in network.parts) {
					let seen = entry.seen - part.age, lifetime = part.ttl ?? ttl;
					let anchor = entry.report_seen?.[target.ssid]?.[part.source];
					if (anchor?.revision == part.envelope.revision) {
						seen = min(seen, anchor.seen);
						lifetime = min(lifetime, anchor.ttl ?? ttl);
					}
					if (now < seen || now - seen >= lifetime)
						item.reason = 'peer_reports_stale';
					for (let row in part.envelope.reports)
						if (own[row.bssid])
							item.reason = 'bssid_collision';
					push(item.parts, { source: part.source, envelope: part.envelope, digest: part.digest, seen, ttl: lifetime });
				}
			}
		}
		if (item.reason != 'ready')
			item.parts = [];
		push(result, item);
	}
	let owners = {};
	for (let p in result)
		if (p.auto && p.reason == 'ready')
			for (let part in p.parts)
				for (let row in part.envelope.reports) {
					if (owners[row.bssid] && owners[row.bssid] !== p) {
						p.reason = owners[row.bssid].reason = 'bssid_collision';
					} else {
						owners[row.bssid] = p;
					}
				}
	for (let p in result)
		if (p.auto && p.reason != 'ready')
			p.parts = [];
	return result;
}


// Retain a bounded history across temporary omission as well as HTTP failure.
// A live observer heartbeat cannot restart an unchanged report generation's age.
function row_state(reason) {
	if (reason == 'ready') return 'active';
	if (index(['not_selected', 'local_disabled'], reason) >= 0) return 'disabled';
	if (index(['peer_stale', 'peer_reports_stale'], reason) >= 0) return 'stale';
	if (index(['identity_mismatch', 'peer_security_mismatch', 'peer_ambiguous', 'local_ambiguous', 'bssid_collision'], reason) >= 0) return 'mismatch';
	if (index(['peer_upgrade_required', 'local_security_unknown'], reason) >= 0) return 'unsupported';
	if (reason == 'apply_failed') return 'error';
	if (index(['peer_unreachable', 'peer_forbidden', 'peer_unavailable', 'local_unavailable'], reason) >= 0) return 'unavailable';
	return 'pending';
}

export function roaming_status(cursor, peers, cache, now, wall) {
	let networks = configured_networks(cursor), workers = {}, raw_workers = {}, overlays = {};
	let own = local_profile_bssids_from_public(cursor);
	for (let network in networks)
		for (let p in network.profiles) {
			workers[p.id] = worker_status(p.id, now);
			raw_workers[p.id] = read_json(profile_state(p.id) + '/status.json', 65536);
			if (length(filter(peers, peer => peer.automatic && index(peer.ssids ?? [], network.ssid) >= 0)))
				overlays[p.id] = roaming_overlay(cursor, p.id, now, cache, own);
		}
	for (let peer in peers) {
		peer.ssids = selected_ssids(peer, networks);
		peer.roaming = [];
		for (let name in peer.ssids) {
			let network = filter(networks, n => n.ssid == name)[0];
			let enabled = filter(network?.profiles ?? [], p => p.enabled);
			let row = { ssid: name, state: 'pending', reason: 'awaiting_apply', local_applied: false,
				age: peer.age, updated_at: peer.updated_at, bssid_count: 0 };
			let reason = !network ? 'local_unavailable' : network.ambiguous ? 'local_ambiguous' :
				!length(enabled) || length(enabled) < length(network.sections) ? 'local_disabled' :
				!network.security ? 'local_security_unknown' : 'ready';
			let bssids = {};
			if (reason == 'ready' && peer.automatic) {
				if (peer.status != 'fresh')
					reason = peer.status == 'stale' ? 'peer_stale' : peer.status == 'unreachable' ? 'peer_unreachable' :
						peer.status == 'forbidden' ? 'peer_forbidden' : 'peer_unavailable';
				for (let p in enabled) {
					if (reason != 'ready') break;
					let overlay = filter(overlays[p.id] ?? [], item => item.bridge_mac == peer.bridge_mac)[0];
					if (!overlay || overlay.reason != 'ready') {
						reason = overlay?.reason ?? 'awaiting_apply';
						break;
					}
					let digests = sort(map(overlay.parts, part => part.digest));
					let expected = [];
					for (let part in overlay.parts) {
						row.age = max(row.age ?? 0, now - part.seen);
						for (let report in part.envelope.reports) {
							push(expected, report.bssid);
							bssids[report.bssid] = true;
						}
					}
					let worker = workers[p.id], raw = raw_workers[p.id];
					if (!worker || worker.ssid != name) {
						reason = raw?.state == 'error' && match(raw.reason ?? '', /^apply_/) ? 'apply_failed' : 'local_unavailable';
						break;
					}
					row.age = max(row.age ?? 0, now - worker.sampled_uptime);
					let proof = filter(array(worker.applied_peers), item => item.bridge_mac == peer.bridge_mac && item.address == peer.address)[0];
					if (!proof?.applied || sprintf('%J', sort(array(proof.digests))) != sprintf('%J', digests) ||
					    sprintf('%J', sort(array(proof.bssids))) != sprintf('%J', sort(expected)))
						reason = 'awaiting_apply';
				}
			} else if (reason == 'ready') {
				// Earlier pinned peers keep their strict v1 path and are proved
				// from the same worker's actually applied request, without claiming
				// the new automatic BSSID discovery protocol is available there.
				for (let p in enabled) {
					let worker = workers[p.id], raw = raw_workers[p.id];
					if (!worker || worker.ssid != name) {
						reason = raw?.state == 'error' && match(raw.reason ?? '', /^apply_/) ? 'apply_failed' : 'local_unavailable';
						break;
					}
					let proof = filter(array(worker.applied_peers), item => item.bridge_mac == peer.bridge_mac && item.address == peer.address)[0];
					let allowed = peer.profiles[p.id] ?? [];
					if (!proof?.applied || !length(array(proof.bssids)) ||
					    length(filter(proof.bssids, value => index(allowed, value) < 0))) {
						reason = 'awaiting_apply';
						break;
					}
					for (let value in proof.bssids) bssids[value] = true;
					row.age = max(row.age ?? 0, now - worker.sampled_uptime);
				}
			}
			row.reason = reason;
			row.state = row_state(reason);
			row.local_applied = reason == 'ready';
			row.updated_at = row.age == null ? null : wall - row.age;
			row.bssid_count = length(bssids);
			push(peer.roaming, row);
		}
	}
	return peers;
}

export function report_anchors(previous, snapshot, now) {
	let anchors = {}, count = 0, valid = true;
	for (let network in snapshot.roaming ?? []) {
		anchors[network.ssid] = {};
		for (let part in network.parts) {
			let before = previous?.[network.ssid]?.[part.source];
			let seen = now - (snapshot.sample_age ?? 0) - part.age, lifetime = part.ttl ?? ttl;
			if (before?.revision == part.envelope.revision) {
				if (before.digest != part.digest) valid = false;
				seen = min(seen, before.seen);
				lifetime = min(lifetime, before.ttl ?? ttl);
			}
			anchors[network.ssid][part.source] = { revision: part.envelope.revision,
				digest: part.digest, seen, ttl: lifetime };
			count++;
		}
	}
	let retained = [];
	for (let name, sources in previous ?? {})
		for (let source, value in sources)
			if (!anchors[name]?.[source]) push(retained, { name, source, value });
	sort(retained, (a,b) => b.value.seen - a.value.seen);
	for (let old in retained) {
		if (count++ >= 32) break;
		anchors[old.name] ??= {};
		anchors[old.name][old.source] = old.value;
	}
	return { anchors, valid };
}

export function roaming_conflict(previous, candidate) {
	for (let network in candidate?.roaming ?? []) {
		let old = filter(previous?.roaming ?? [], item => item.ssid == network.ssid)[0];
		for (let part in network.parts) {
			let before = filter(old?.parts ?? [], item => item.source == part.source)[0];
			if (before?.envelope.revision == part.envelope.revision &&
			    (sprintf('%J', before.envelope) != sprintf('%J', part.envelope) || before.digest != part.digest))
				return true;
		}
	}
	return false;
}


export function local_profile_bssids(cursor, bus) {
	let result = advertised_profiles(cursor, identity(bus).bridge_mac);
	let ssids = local_ssids(cursor, bus);
	for (let p in local_profiles(cursor, ssids)) {
		let network = filter(ssids, item => item.section == p.section)[0];
		let addresses = [network?.bssid, ...map(network?.links ?? [], link => link.bssid)];
		result[p.id] ??= [];
		for (let address in addresses)
			if (address && index(result[p.id], address) < 0)
				push(result[p.id], address);
	}
	return result;
}

function monotonic_ms() {
	let value = clock(true) ?? clock();
	return value[0] * 1000 + int(value[1] / 1000000);
}

export function fetch_response(lan, address, identity_only) {
	if (!on_lan(lan, address))
		return { status: 'unreachable' };
	let directory = fs.mkdtemp('/tmp/wrtmesh-fetch.XXXXXX');
	if (!directory)
		return { status: 'unavailable' };
	let file = directory + '/reply';
	let headers = directory + '/headers';
	let max_bytes = identity_only ? 4096 : response_limit;
	let query = identity_only ? '?identity=1' : '';
	let started = monotonic_ms();
	let result = { status: 'unreachable' };
	try {
		// The old information endpoint is tried only after a canonical 404.
		// Both attempts share the existing per-peer deadline.
		for (let path in ['/cgi-bin/wrtmesh', '/cgi-bin/xr-mesh']) {
			let remaining = 2500 - (monotonic_ms() - started);
			if (remaining <= 0)
				break;
			fs.unlink(headers);
			let rc = system(['/usr/bin/curl', '--disable', '--silent', '--fail', '--noproxy', '*',
				'--proto', '=http', '--interface', lan.address, '--connect-timeout', '1',
				'--max-time', sprintf('%.3f', min(2000, remaining) / 1000),
				'--max-filesize', sprintf('%d', max_bytes), '--dump-header', headers, '--output', file,
				'http://' + address + path + query], remaining);
			let code = int(match(fs.readfile(headers, 128) ?? '', /^HTTP\/[0-9.]+ ([0-9]{3})[[:space:]]/)?.[1]);
			if (!rc && code == 200)
				result = { status: 'ok', data: read_json(file, max_bytes) };
			else if (code == 401 || code == 403)
				result.status = 'forbidden';
			else if (code == 503)
				result.status = 'stale';
			else if (code)
				result.status = 'unavailable';
			else
				result.status = 'unreachable';
			if (code != 404)
				break;
		}
	} catch (e) {
		result.status = 'unavailable';
	}
	fs.unlink(file);
	fs.unlink(headers);
	fs.rmdir(directory);
	return result;
}

export function fetch(lan, address, identity_only) {
	return fetch_response(lan, address, identity_only).data;
}

export function path(raw) {
	return {
		bridge: dev(raw?.bridge),
		port: dev(raw?.port),
		medium: index(['ethernet', 'wireless'], raw?.medium) >= 0 ? raw.medium : null
	};
}

export function station_ip(value, size) {
	let bytes = iptoarr(value);
	if (length(bytes) != size || !length(filter(bytes, n => n)) ||
	    (size == 4 ? bytes[0] >= 224 : bytes[0] == 255))
		return null;
	return arrtoip(bytes);
}

function valid_int(value, min, max) {
	return type(value) == 'int' && value >= min && value <= max ? value : null;
}

export function link_id(value) {
	return valid_int(value, 0, 15);
}

export function station_link(raw) {
	let id = link_id(raw?.id), addr = mac(raw?.mac), bssid = mac(raw?.bssid);
	if (id == null || !addr || !bssid)
		return null;
	let link = { id, mac: addr, bssid };
	for (let key, value in {
		freq: valid_int(raw.freq, 2000, 7125), channel: valid_int(raw.channel, 1, 233),
		signal: valid_int(raw.signal, -127, 0),
		rx: valid_int(raw.rx, 1, 0xffffffff), tx: valid_int(raw.tx, 1, 0xffffffff)
	})
		if (value != null)
			link[key] = value;
	return link;
}

export function station(raw) {
	let addr = mac(raw?.mac);
	if (!addr)
		return null;
	// Preserve the unsigned C7 hostapd get_clients values (100 times kbit/s).
	let sta = { mac: addr, ssid: label(raw.ssid, 32), iface: dev(raw.iface),
		ipv4: station_ip(raw.ipv4, 4), ipv6: station_ip(raw.ipv6, 16),
		signal: valid_int(raw.signal, -127, 0), rx: valid_int(raw.rx, 1, 0xffffffff),
		tx: valid_int(raw.tx, 1, 0xffffffff) };
	for (let key, value in {
		name: label(raw.name, 64), bssid: mac(raw.bssid), freq: valid_int(raw.freq, 2000, 7125),
		channel: valid_int(raw.channel, 1, 233), mld: mac(raw.mld) == addr ? addr : null,
		ap_mld: mac(raw.ap_mld)
	})
		if (value)
			sta[key] = value;
	if (sta.mld) {
		let links = {};
		for (let item in slice(array(raw.links), 0, 16)) {
			let link = station_link(item);
			if (link)
				links[link.id] ??= link;
		}
		if (length(links))
			sta.links = values(links);
		let assoc = link_id(raw.assoc_link_id);
		if (assoc != null && links[assoc])
			sta.assoc_link_id = assoc;
	}
	return sta;
}

export function station_key(sta) {
	return sta.mld ? sta.mld + '/' + (sta.ap_mld ?? sta.iface ?? '') + '/' + (sta.ssid ?? '') : sta.mac;
}

export function merge_station(existing, candidate) {
	if (!existing)
		return candidate;
	let prefer_new = candidate.signal != null && (existing.signal == null || candidate.signal > existing.signal);
	let best = prefer_new ? candidate : existing;
	let other = prefer_new ? existing : candidate;
	if (!best.mld || !length(other.links))
		return best;
	let links = {};
	for (let link in other.links)
		links[link.id] = link;
	for (let link in best.links ?? []) {
		let previous = links[link.id];
		links[link.id] = previous?.mac == link.mac && previous?.bssid == link.bssid ?
			{ ...previous, ...link } : link;
	}
	return { ...best, links: values(links) };
}

// Keep the v1 HTTP body, local wrapper and 15-peer cache below their existing
// limits even when every client includes a hostname and several links.
export function bounded_snapshot(snapshot) {
	let budget = response_limit - 8192 - length(sprintf('%J', { ...snapshot, stations: [] }));
	let kept = [];
	for (let sta in snapshot.stations) {
		budget -= length(sprintf('%J', sta)) + 2;
		if (budget < 0)
			break;
		push(kept, sta);
	}
	return { ...snapshot, stations: kept, truncated: snapshot.truncated || length(kept) < length(snapshot.stations) };
}

export function snapshot(raw, addr) {
	if (raw?.version != 1 || raw.bridge_mac != addr ||
	    !clean_string(raw.revision) ||
	    !match(raw.revision, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/) ||
	    (raw.sample_age != null && valid_int(raw.sample_age, 0, ttl - 1) == null) ||
	    type(raw.stations) != 'array' || length(raw.stations) > 256 ||
	    type(raw.paths) != 'object' || length(raw.paths) > limit)
		return null;
	let stations = {}, paths = {}, roaming = null;
	if (raw.roaming != null) {
		if (type(raw.roaming) != 'array' || length(raw.roaming) > 17)
			return null;
		roaming = [];
		let names = {}, sources = {}, report_owners = {}, part_count = 0;
		for (let item in raw.roaming) {
			let network = roaming_network(item, addr);
			if (!network || names[network.ssid])
				return null;
			names[network.ssid] = true;
			for (let part in network.parts) {
				if (sources[part.source] || ++part_count > 17)
					return null;
				sources[part.source] = true;
				for (let row in part.envelope.reports) {
					if (report_owners[row.bssid])
						return null;
					report_owners[row.bssid] = true;
				}
			}
			push(roaming, network);
		}
	}
	for (let item in raw.stations) {
		let s = station(item);
		if (!s)
			return null;
		let key = station_key(s);
		stations[key] = merge_station(stations[key], s);
	}
	for (let key, item in raw.paths) {
		if (mac(key) == key)
			paths[key] = path(item);
	}
	let gateway = raw.gateway;
	return bounded_snapshot({ version: 1, bridge_mac: addr, name: label(raw.name, 64) || '',
		revision: raw.revision, stations: values(stations), truncated: raw.truncated === true,
		...(roaming != null ? { roaming } : {}),
		sample_age: valid_int(raw.sample_age, 0, ttl - 1),
		paths, gateway: ipv4(gateway?.address) ?
			{ address: gateway.address, mac: mac(gateway.mac), ...path(gateway) } : null });
}

export function age(sample, now) {
	return type(sample?.seen) == 'int' && now >= sample.seen ? now - sample.seen : null;
}

export function current(sample, now) {
	let elapsed = age(sample, now);
	return elapsed != null && elapsed < ttl;
}

export function cursor() {
	return uci.cursor();
}
