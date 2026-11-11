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

export function mac(s) {
	if (type(s) != 'string')
		return null;
	s = lc(s);
	return match(s, /^[0-9a-f][02468ace](:[0-9a-f]{2}){5}$/) &&
		s != '00:00:00:00:00:00' ? s : null;
}

export function ipv4(s) {
	if (type(s) != 'string' || !match(s, /^(0|[1-9][0-9]{0,2})(\.(0|[1-9][0-9]{0,2})){3}$/))
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
	return type(s) == 'string' && match(s, /^[a-zA-Z0-9_.-]{1,15}$/) ? s : null;
}

export function profile(s) {
	return type(s) == 'string' && match(s, /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/) ? s : null;
}

export function label(s, max) {
	return type(s) == 'string' && length(s) <= max && !match(s, /[[:cntrl:]]/) ? s : null;
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
	return type(value) == 'string' && match(value, /^[A-Za-z0-9_]{1,64}$/) ? value : null;
}

export function profile_metadata(iface, mlo, max_links) {
	return type(iface) == 'string' && match(iface, /^[A-Za-z][A-Za-z0-9_.-]{0,14}$/) &&
		type(mlo) == 'bool' && type(max_links) == 'int' && max_links >= 1 && max_links <= 3 &&
		(mlo || max_links == 1) ? { iface, mlo, max_links } : null;
}

export function profile_timers(interval, ttl) {
	return type(interval) == 'int' && interval >= 30 && interval <= 300 &&
		type(ttl) == 'int' && ttl >= 180 && ttl <= 1800 && ttl >= interval * 3;
}

function option_number(value) {
	return type(value) == 'string' && match(value, /^(0|[1-9][0-9]{0,9})$/) ? int(value) : null;
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
			s.disabled == '1' || !available ? 'profile_runtime_unavailable' :
			status.ssid != ssid || (s.mlo == '1' && !mlo) ? 'profile_runtime_mismatch' :
			!metadata ? 'profile_metadata_unsupported' : null;
		push(result, { section, ssid, devices, disabled: s.disabled == '1', available,
			supported: reason == null, reason, iface, mlo, max_links, links,
			bssid: mac(status.bssid) ?? mac(s.macaddr) });
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
			disabled: s.disabled == '1', profiles: {} };
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

export function advertised_profiles(cursor, addr) {
	let result = {};
	for (let id in keys(profiles(cursor))) {
		let path = '/tmp/wrtmesh-public/' + (id == 'main' ? '' : id + '/') + 'own.json';
		let own = read_json(path, 16384);
		if (own?.version != 1 || own.bridge_mac != addr || !array(own.reports)[0])
			continue;
		let list = pins(map(own.reports, r => r?.bssid));
		if (list)
			result[id] = list;
	}
	return result;
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
	let budget = response_limit - 4096 - length(sprintf('%J', { ...snapshot, stations: [] }));
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
	    type(raw.revision) != 'string' ||
	    !match(raw.revision, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/) ||
	    (raw.sample_age != null && valid_int(raw.sample_age, 0, ttl - 1) == null) ||
	    type(raw.stations) != 'array' || length(raw.stations) > 256 ||
	    type(raw.paths) != 'object' || length(raw.paths) > limit)
		return null;
	let stations = {}, paths = {};
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
