// SPDX-License-Identifier: GPL-2.0-only
'use strict';

import * as fs from 'fs';
import * as ubus from 'ubus';
import * as rtnl from 'rtnl';
import * as mesh from '/usr/lib/xr-roaming/mesh.uc';

let bus = ubus.connect(null, 1);
let config = mesh.cursor();
let overrides = mesh.overrides(config);

if (ARGV[0] == 'roaming') {
	let result = [];
	for (let addr, p in overrides)
		push(result, { id: mesh.peer_key(addr), bridge_mac: addr, address: p.address,
			bssids: p.profiles[ARGV[1]] ?? [], disabled: p.disabled });
	print(result, '\n');
	exit(0);
}

function write(name, value) {
	let file = mesh.state + '/' + name + '.json';
	if (fs.writefile(file + '.new', value))
		fs.rename(file + '.new', file);
}

function stations() {
	let found = {}, truncated = false;
	for (let obj in slice(bus?.list('hostapd.*') ?? [], 0, 64)) {
		let status = mesh.call(bus, obj, 'get_status');
		if (status.status != 'ENABLED' || !status.ssid)
			continue;
		let result = mesh.call(bus, obj, 'get_clients');
		for (let mac, c in result.clients ?? {}) {
			if (!c?.assoc || !c.authorized)
				continue;
			let sta = mesh.station({
				mac: c.mld_addr ?? mac, ssid: status.ssid, iface: substr(obj, 8),
				signal: c.signal, rx: c.rate?.rx, tx: c.rate?.tx
			});
			if (!sta)
				continue;
			if (!found[sta.mac] && length(found) >= 256) {
				truncated = true;
				continue;
			}
			if (!found[sta.mac] || (sta.signal != null &&
			    (found[sta.mac].signal == null || sta.signal > found[sta.mac].signal)))
				found[sta.mac] = sta;
		}
	}
	return { stations: values(found), truncated };
}

function neighbours(family) {
	let r = rtnl.const;
	return mesh.array(rtnl.request(r.RTM_GETNEIGH, r.NLM_F_DUMP, { family }));
}

function topology(lan, peers) {
	let neighbours4 = neighbours(rtnl.const.AF_INET);
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
let local = { version: 1, ...node, ...stations(), ...topology(lan, peers),
	revision: trim(fs.readfile('/proc/sys/kernel/random/uuid', 40) ?? '') };
write('local', { seen: now, data: local });

let previous = mesh.read_json(mesh.state + '/peers.json', 1048576) ?? {};
let cache = {};
for (let p in peers) {
	if (!mesh.on_lan(lan, p.address))
		continue;
	let addr = p.bridge_mac;
	let old = previous[addr];
	let reply = mesh.snapshot(mesh.fetch(lan, p.address, false), addr);
	if (old?.address != p.address)
		old = null;
	if (reply && reply.revision != old?.data?.revision)
		cache[addr] = { address: p.address, seen: mesh.uptime(), data: reply };
	else if (mesh.current(old, mesh.uptime()))
		cache[addr] = old;
}
write('peers', cache);
