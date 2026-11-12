// SPDX-License-Identifier: GPL-2.0-only
'use strict';

import * as fs from 'fs';
import * as ubus from 'ubus';
import * as rtnl from 'rtnl';
import * as mesh from '/usr/lib/wrtmesh/mesh.uc';

let bus;
let config = mesh.cursor();
let overrides = mesh.overrides(config);

if (ARGV[0] == 'roaming') {
	print(mesh.roaming_overlay(config, ARGV[1], mesh.uptime()), '\n');
	exit(0);
}

let connection = ubus.connect(null, 1), sample_cache = {};
bus = {
	list: pattern => connection?.list(pattern),
	call: (object, method, args) => {
		let key = object + ':' + method;
		if ((method == 'get_status' && substr(object, 0, 8) == 'hostapd.') ||
		    key == 'network.wireless:status') {
			if (key in sample_cache)
				return sample_cache[key];
			return sample_cache[key] = connection?.call(object, method, args);
		}
		return connection?.call(object, method, args);
	}
};

function write(name, value) {
	let file = mesh.state + '/' + name + '.json';
	if (fs.writefile(file + '.new', sprintf('%J', value)))
		fs.rename(file + '.new', file);
}

function neighbours(family) {
	let r = rtnl.const;
	return mesh.array(rtnl.request(r.RTM_GETNEIGH, r.NLM_F_DUMP, { family }));
}

function channel(freq) {
	if (freq == 2484)
		return 14;
	if (freq == 5935)
		return 2;
	if (type(freq) != 'int')
		return null;
	let base = freq >= 2412 && freq <= 2472 ? 2407 :
		freq >= 4910 && freq <= 4980 ? 4000 :
		freq >= 5005 && freq <= 5895 ? 5000 :
		freq >= 5955 && freq <= 7115 ? 5950 : null;
	return base != null && (freq - base) % 5 == 0 ? int((freq - base) / 5) : null;
}

function client_station(key, client, iface, status, bss_links) {
	let mld = mesh.mac(client.mld_addr), ap_mld = mesh.mac(client.ap_mld_address);
	let assoc_id = mesh.link_id(client.assoc_link_id);
	let links = [], assoc;
	for (let item in slice(mesh.array(client.links), 0, 16)) {
		let id = mesh.link_id(item.link_id), bss = id != null ? bss_links[id] : null;
		let bssid = mesh.mac(item.bssid);
		let freq = bssid && mesh.mac(bss?.bssid) == bssid ? bss.freq : null;
		let link = mesh.station_link({ id, mac: item.address, bssid, freq, channel: channel(freq),
			signal: id == assoc_id ? client.signal : null,
			rx: id == assoc_id ? client.rate?.rx : null,
			tx: id == assoc_id ? client.rate?.tx : null });
		if (!link)
			continue;
		push(links, link);
		if (id == assoc_id)
			assoc = link;
	}
	// C7 get_clients keys an MLD by its MLD address. Its AP MLD identity and
	// accepted association-link record distinguish this from an ordinary STA.
	if (!mld && ap_mld && assoc)
		mld = mesh.mac(key);
	let single_bss = length(bss_links) <= 1;
	let freq = assoc?.freq ?? (single_bss ? status.freq : null);
	return mesh.station({ mac: mld ?? key, mld, ap_mld, ssid: status.ssid, iface,
		bssid: assoc?.bssid ?? (single_bss ? status.bssid : null), freq,
		channel: assoc?.channel ?? (single_bss ? status.channel : channel(freq)),
		links, assoc_link_id: assoc_id, signal: client.signal, rx: client.rate?.rx, tx: client.rate?.tx });
}

function station_hints(stations, neighbours4) {
	let aliases = {};
	for (let sta in stations) {
		for (let addr in [sta.mac, ...map(sta.links ?? [], link => link.mac)])
			aliases[addr] = addr in aliases && aliases[addr] !== sta ? null : sta;
	}
	for (let row in neighbours4) {
		let sta = aliases[mesh.mac(row.lladdr) ?? ''];
		if (sta && !sta.ipv4 && !(row.state & (0x01 | 0x20)))
			sta.ipv4 = mesh.station_ip(row.dst, 4);
	}
	for (let row in neighbours(rtnl.const.AF_INET6)) {
		let sta = aliases[mesh.mac(row.lladdr) ?? ''];
		if (sta && !(row.state & (0x01 | 0x20))) {
			let address = mesh.station_ip(row.dst, 16);
			if (address && (!sta.ipv6 || match(sta.ipv6, /^fe[89ab]/)))
				sta.ipv6 = address;
		}
	}
	let leases = fs.readfile('/tmp/dhcp.leases', 65536) ?? '';
	let now = time();
	for (let line in split(leases, '\n')) {
		let fields = split(trim(line), /[ \t]+/);
		let sta = aliases[mesh.mac(fields[1]) ?? ''];
		if (!sta || length(fields) < 5 || !match(fields[0], /^[0-9]+$/) ||
		    (int(fields[0]) != 0 && int(fields[0]) <= now))
			continue;
		sta.ipv4 ??= mesh.station_ip(fields[2], 4);
		if (fields[3] != '*')
			sta.name ??= mesh.label(fields[3], 64);
	}
}

function stations(neighbours4) {
	let found = {}, truncated = false;
	// A patterned ubus list returns method signatures instead of object names.
	let objects = filter(bus?.list() ?? [], obj => substr(obj, 0, 8) == 'hostapd.');
	for (let obj in slice(objects, 0, 64)) {
		let status = mesh.call(bus, obj, 'get_status');
		if (status.status != 'ENABLED' || !status.ssid)
			continue;
		let bss_links = {};
		for (let link in slice(mesh.array(status.links), 0, 16)) {
			let id = mesh.link_id(link.link_id);
			if (id != null)
				bss_links[id] = link;
		}
		let result = mesh.call(bus, obj, 'get_clients');
		for (let key, c in result.clients ?? {}) {
			if (!c?.assoc || !c.authorized)
				continue;
			let sta = client_station(key, c, substr(obj, 8), status, bss_links);
			if (!sta)
				continue;
			let id = mesh.station_key(sta);
			if (!found[id] && length(found) >= 256) {
				truncated = true;
				continue;
			}
			found[id] = mesh.merge_station(found[id], sta);
		}
	}
	let clients = values(found);
	if (length(clients))
		station_hints(clients, neighbours4);
	return { stations: clients, truncated };
}

function topology(lan, peers, neighbours4) {
	let fdb = neighbours(rtnl.const.AF_BRIDGE);
	let wireless = {};
	for (let radio in values(mesh.call(bus, 'network.wireless', 'status'))) {
		for (let iface in mesh.array(radio.interfaces)) {
			if (mesh.dev(iface.ifname))
				wireless[iface.ifname] = true;
		}
	}
	let device_cache = {};
	function find_path(device, addr) {
		if (!device)
			return mesh.path(null);
		let parts = match(device, /^(.+)\.([0-9]{1,4})$/);
		let bridge = parts ? parts[1] : device;
		let status = device_cache[bridge] ??= mesh.call(bus, 'network.device', 'status', { name: bridge });
		let members = mesh.array(status['bridge-members']);
		if (status.type != 'bridge' && !length(members)) {
			let port = parts ? bridge : device;
			let ethernet = trim(fs.readfile('/sys/class/net/' + port + '/type', 16) ?? '') == '1';
			return mesh.path({ port, medium: wireless[port] ? 'wireless' : ethernet ? 'ethernet' : null });
		}

		let ports = {};
		for (let row in fdb) {
			if (addr && mesh.mac(row.lladdr) == addr && index(members, row.dev) >= 0 &&
			    (!row.master || row.master == bridge) &&
			    (parts ? row.vlan == int(parts[2]) : !row.vlan) &&
			    !(row.state & 0x40))
				ports[row.dev] = true;
		}
		let names = keys(ports);
		let port = length(names) == 1 ? names[0] : null;
		return mesh.path({ bridge, port, medium: port ? (wireless[port] ? 'wireless' : 'ethernet') : null });
	}
	function neighbour(address, device) {
		for (let row in neighbours4)
			if (row.dst == address && row.dev == device && !(row.state & (0x01 | 0x20)))
				return mesh.mac(row.lladdr);
	}
	let paths = {};
	if (lan) {
		for (let p in peers) {
			if (mesh.on_lan(lan, p.address))
				paths[p.bridge_mac] = find_path(lan.device, neighbour(p.address, lan.device) ?? p.bridge_mac);
		}
	}
	let default_route;
	let interfaces = mesh.call(bus, 'network.interface', 'dump').interface;
	for (let net in mesh.array(interfaces)) {
		if (!net.up || !mesh.dev(net.l3_device))
			continue;
		for (let route in mesh.array(net.route)) {
			if (route.target == '0.0.0.0' && route.mask == 0 &&
			    (!default_route || (route.metric ?? 0) < default_route.metric))
				default_route = { address: route.nexthop, metric: route.metric ?? 0,
					device: net.l3_device, ppp: match(net.proto ?? '', /^ppp/) };
		}
	}
	let gateway = null;
	if (default_route && !default_route.ppp && mesh.ipv4(default_route.address) &&
	    default_route.address != '0.0.0.0') {
		let addr = neighbour(default_route.address, default_route.device);
		gateway = { address: default_route.address, mac: addr,
			...find_path(default_route.device, addr) };
	}
	return { paths, gateway };
}

let lan = mesh.lan_status(bus);
let node = mesh.identity(bus);
let now = mesh.uptime();
let peers = slice(filter(mesh.peer_inventory(config, overrides).peers, p => p.bridge_mac != node.bridge_mac), 0, mesh.limit);
let neighbours4 = neighbours(rtnl.const.AF_INET);
let local = mesh.bounded_snapshot({ version: 1, ...node, ...stations(neighbours4), ...topology(lan, peers, neighbours4),
	roaming: mesh.local_roaming(config, bus, node.bridge_mac, now),
	revision: trim(fs.readfile('/proc/sys/kernel/random/uuid', 40) ?? '') });
write('local', { seen: now, data: local });

let previous = mesh.read_json(mesh.state + '/peers.json', mesh.cache_limit) ?? {};
let cache = {};
for (let p in peers) {
	let addr = p.bridge_mac;
	let old = previous[addr]?.address == p.address ? previous[addr] : null;
	let result = mesh.fetch_response(lan, p.address, false);
	let reply = mesh.snapshot(result.data, addr);
	let identity = mesh.peer_binding(neighbours4, lan, p);
	if (mesh.mac(result.data?.bridge_mac) && result.data.bridge_mac != addr)
		identity = 'mismatch';
	let received = mesh.uptime();
	let entry = { address: p.address, identity, report_seen: old?.report_seen ?? {},
		seen: old?.seen, revision: old?.revision ?? old?.data?.revision,
		status: result.status == 'ok' ? 'unavailable' : result.status };
	if (reply && mesh.roaming_conflict(old?.data, reply))
		reply = null;
	if (reply) {
		let record = mesh.report_anchors(old?.report_seen, reply, received);
		if (record.valid) entry.report_seen = record.anchors;
		else reply = null;
	}
	if (reply) {
		if (reply.revision != entry.revision) {
			entry.revision = reply.revision;
			entry.seen = received - (reply.sample_age ?? 0);
		}
		entry.status = mesh.current(entry, received) ? 'fresh' : 'stale';
		if (entry.status == 'fresh')
			entry.data = reply;
	}
	cache[addr] = entry;
}
write('peers', cache);
