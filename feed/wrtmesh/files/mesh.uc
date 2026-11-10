// SPDX-License-Identifier: GPL-2.0-only
'use strict';

import * as fs from 'fs';
import * as uci from 'uci';

export const state = '/tmp/xr-roaming-private/mesh';
export const ttl = 95;
export const limit = 15;
export const service = '_xr-roaming._tcp';

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

export function profiles(cursor) {
	let result = {};
	cursor.foreach('xr_roaming', 'roaming', s => {
		if (s.enabled == '1' && profile(s['.name']))
			result[s['.name']] = true;
	});
	return result;
}

export function overrides(cursor) {
	let result = {};
	cursor.foreach('xr_mesh', 'peer', s => {
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
	cursor.foreach('xr_roaming', 'peer', s => { provisioned[s['.name']] = s; });
	cursor.foreach('xr_roaming', 'roaming', s => {
		let id = s['.name'];
		if (s.enabled != '1' || !profile(id))
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
		let path = '/tmp/xr-roaming-public/' + (id == 'main' ? '' : id + '/') + 'own.json';
		let own = read_json(path, 16384);
		if (own?.version != 1 || own.bridge_mac != addr || !array(own.reports)[0])
			continue;
		let list = pins(map(own.reports, r => r?.bssid));
		if (list)
			result[id] = list;
	}
	return result;
}

export function fetch(lan, address, identity_only) {
	if (!on_lan(lan, address))
		return null;
	let directory = fs.mkdtemp('/tmp/xr-mesh-fetch.XXXXXX');
	if (!directory)
		return null;
	let file = directory + '/reply';
	let max = identity_only ? 4096 : 65536;
	let path = '/cgi-bin/xr-mesh' + (identity_only ? '?identity=1' : '');
	let result;
	try {
		let rc = system(['/usr/bin/curl', '--disable', '--silent', '--fail', '--noproxy', '*',
			'--proto', '=http', '--interface', lan.address, '--connect-timeout', '1',
			'--max-time', '2', '--max-filesize', sprintf('%d', max), '--output', file,
			'http://' + address + path], 2500);
		if (!rc)
			result = read_json(file, max);
	} catch (e) {
		result = null;
	}
	fs.unlink(file);
	fs.rmdir(directory);
	return result;
}

export function path(raw) {
	return {
		bridge: dev(raw?.bridge),
		port: dev(raw?.port),
		medium: index(['ethernet', 'wireless'], raw?.medium) >= 0 ? raw.medium : null
	};
}

export function station(raw) {
	let addr = mac(raw?.mac);
	if (!addr)
		return null;
	let signal = raw.signal, rx = raw.rx, tx = raw.tx;
	return { mac: addr, ssid: label(raw.ssid, 32), iface: dev(raw.iface),
		signal: type(signal) == 'int' && signal >= -127 && signal <= 0 ? signal : null,
		rx: type(rx) == 'int' && rx > 0 && rx <= 100000000 ? rx : null,
		tx: type(tx) == 'int' && tx > 0 && tx <= 100000000 ? tx : null };
}

export function snapshot(raw, addr) {
	if (raw?.version != 1 || raw.bridge_mac != addr ||
	    type(raw.revision) != 'string' ||
	    !match(raw.revision, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/) ||
	    type(raw.stations) != 'array' || length(raw.stations) > 256 ||
	    type(raw.paths) != 'object' || length(raw.paths) > limit)
		return null;
	let stations = {}, paths = {};
	for (let item in raw.stations) {
		let s = station(item);
		if (!s)
			return null;
		stations[s.mac] = s;
	}
	for (let key, item in raw.paths) {
		if (mac(key) == key)
			paths[key] = path(item);
	}
	let gateway = raw.gateway;
	return { version: 1, bridge_mac: addr, name: label(raw.name, 64) || '',
		revision: raw.revision, stations: values(stations), truncated: raw.truncated === true,
		paths, gateway: ipv4(gateway?.address) ?
			{ address: gateway.address, mac: mac(gateway.mac), ...path(gateway) } : null };
}

export function current(sample, now) {
	return type(sample?.seen) == 'int' && now >= sample.seen && now - sample.seen < ttl;
}

export function cursor() {
	return uci.cursor();
}
