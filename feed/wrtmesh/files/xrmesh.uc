// SPDX-License-Identifier: GPL-2.0-only
'use strict';

import * as ubus from 'ubus';
import * as mesh from '/usr/lib/xr-roaming/mesh.uc';

function context() {
	let bus = ubus.connect(null, 1);
	let config = mesh.cursor();
	let overrides = mesh.overrides(config);
	return { bus, config, overrides, ...mesh.peer_inventory(config, overrides),
		node: mesh.identity(bus), lan: mesh.lan_status(bus) };
}

function status() {
	let ctx = context();
	let now = mesh.uptime();
	let local = mesh.read_json(mesh.state + '/local.json', 65536);
	let cache = mesh.read_json(mesh.state + '/peers.json', 1048576) ?? {};
	let peers = [];
	for (let p in slice(ctx.peers, 0, mesh.limit)) {
		if (p.bridge_mac == ctx.node.bridge_mac)
			continue;
		let entry = cache[p.bridge_mac];
		let fresh = mesh.on_lan(ctx.lan, p.address) && entry?.address == p.address && mesh.current(entry, now);
		push(peers, { ...p, online: !!fresh, data: fresh ? entry.data : null });
	}
	return {
		local: mesh.current(local, now) && local.data?.bridge_mac == ctx.node.bridge_mac ?
			local.data : ctx.node,
		address: ctx.lan?.address,
		peers, profiles: keys(mesh.profiles(ctx.config))
	};
}

function discover() {
	let ctx = context();
	let records = mesh.call(ctx.bus, 'umdns', 'browse', { service: mesh.service, array: true });
	let hosts = records[mesh.service] ?? {};
	let candidates = {}, pending = false;
	for (let name in slice(keys(hosts), 0, 32)) {
		let record = hosts[name];
		if (!ctx.lan || record.iface != ctx.lan.device || record.port != 80)
			continue;
		let addresses = type(record.ipv4) == 'string' ? [record.ipv4] : mesh.array(record.ipv4);
		if (!length(addresses) && type(record.host) == 'string' && match(record.host, /^xr-[0-9a-f]{12}\.local$/)) {
			// umdns answers a service PTR with an SRV record. Its A record may still be absent.
			mesh.call(ctx.bus, 'umdns', 'query', { question: record.host, interface: ctx.lan.device, type: 1 });
			pending = true;
		}
		for (let addr in addresses) {
			if (mesh.on_lan(ctx.lan, addr) && length(candidates) < 32)
				candidates[addr] = { address: addr, name: mesh.label(name, 64) || addr };
		}
	}
	return { candidates: values(candidates), pending };
}

function identify(args) {
	let ctx = context();
	let data = mesh.fetch(ctx.lan, args.address, true);
	let addr = mesh.mac(data?.bridge_mac);
	if (data?.version != 1 || !addr || addr == ctx.node.bridge_mac)
		return { error: 'identity_unavailable' };
	let profiles = {};
	for (let id in keys(mesh.profiles(ctx.config))) {
		let list = mesh.pins(data.profiles?.[id]);
		if (list)
			profiles[id] = list;
	}
	return { peer: { address: args.address, bridge_mac: addr, name: mesh.label(data.name, 64) || '', profiles } };
}

function commit(ctx, addr, peer) {
	let id = mesh.peer_key(addr);
	if (ctx.config.get('xr_mesh', id))
		ctx.config.delete('xr_mesh', id);
	if (peer) {
		if (!ctx.config.set('xr_mesh', id, 'peer') ||
		    !ctx.config.set('xr_mesh', id, 'bridge_mac', addr))
			return { error: 'save_failed' };
		if (peer.disabled) {
			if (!ctx.config.set('xr_mesh', id, 'disabled', '1'))
				return { error: 'save_failed' };
		} else {
			if (!ctx.config.set('xr_mesh', id, 'address', peer.address) ||
			    !ctx.config.set('xr_mesh', id, 'name', peer.name))
				return { error: 'save_failed' };
			for (let profile, bssids in peer.profiles) {
				if (!ctx.config.set('xr_mesh', id, profile + '_bssid', bssids))
					return { error: 'save_failed' };
			}
		}
	}
	return ctx.config.commit('xr_mesh') ? { saved: true } : { error: 'save_failed' };
}

function save(args) {
	let ctx = context();
	let addr = mesh.mac(args.bridge_mac);
	let name = mesh.label(trim(args.name), 64);
	let address = args.address;
	if (!ctx.node.bridge_mac || !addr || addr == ctx.node.bridge_mac || name == null ||
	    !mesh.on_lan(ctx.lan, address))
		return { error: 'invalid_peer' };

	let peers = filter(ctx.peers, p => p.bridge_mac != addr);
	if (length(peers) >= mesh.limit)
		return { error: 'peer_limit' };
	if (length(filter(peers, p => p.address == address)))
		return { error: 'duplicate_address' };

	let supported = mesh.profiles(ctx.config);
	let own = mesh.advertised_profiles(ctx.config, ctx.node.bridge_mac);
	let pins = { ...((ctx.overrides[addr] ?? ctx.legacy[addr])?.profiles ?? {}) };
	for (let id, raw in args.profiles ?? {}) {
		if (!supported[id])
			return { error: 'invalid_bssid' };
		delete pins[id];
		if (!raw)
			continue;
		let list = mesh.pins(raw);
		if (!list)
			return { error: 'invalid_bssid' };
		for (let bssid in list) {
			if (index(own[id] ?? [], bssid) >= 0 ||
			    length(filter(peers, p => index(p.profiles[id] ?? [], bssid) >= 0)))
				return { error: 'duplicate_bssid' };
		}
		pins[id] = list;
	}
	return commit(ctx, addr, { address, name, profiles: pins });
}

function remove(args) {
	let ctx = context();
	let addr = mesh.mac(args.bridge_mac);
	if (!addr || (!ctx.overrides[addr] && !ctx.legacy[addr]))
		return { error: 'invalid_peer' };
	return commit(ctx, addr, ctx.legacy[addr] ? { disabled: true } : null);
}

return {
	xrmesh: {
		status: { call: status },
		discover: { call: discover },
		scan: { call: () => {
			let bus = ubus.connect(null, 1);
			let lan = mesh.lan_status(bus);
			if (!lan)
				return { error: 'lan_unavailable' };
			let result = bus.call('umdns', 'query', {
				question: mesh.service + '.local', interface: lan.device, type: 12
			});
			return result == null && ubus.error() ? { error: 'discovery_unavailable' } : { scanning: true };
		} },
		identify: { args: { address: '' }, call: req => identify(req.args) },
		save: { args: { address: '', bridge_mac: '', name: '', profiles: {} }, call: req => save(req.args) },
		remove: { args: { bridge_mac: '' }, call: req => remove(req.args) }
	}
};
