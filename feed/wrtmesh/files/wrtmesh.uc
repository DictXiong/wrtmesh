// SPDX-License-Identifier: GPL-2.0-only
'use strict';

import * as ubus from 'ubus';
import * as fs from 'fs';
import * as mesh from '/usr/lib/wrtmesh/mesh.uc';

function mutate(handler, args) {
	let lock = fs.open('/var/lock/wrtmesh-config.lock', 'ae', 0o600);
	if (!lock?.lock('xn')) {
		lock?.close();
		return { error: 'config_busy' };
	}
	let result;
	try {
		let config = mesh.cursor();
		let pending = false;
		for (let name in ['wrtmesh', 'wrtmesh_peers'])
			pending ||= length(config.changes(name)?.[name]) > 0;
		result = pending ? { error: 'config_busy' } : handler(args);
	} catch (e) {
		lock.close();
		return { error: 'save_failed' };
	}
	lock.close();
	return result;
}

function context() {
	let bus = ubus.connect(null, 1);
	let config = mesh.cursor();
	let overrides = mesh.overrides(config);
	return { bus, config, overrides, ...mesh.peer_inventory(config, overrides),
		node: mesh.identity(bus), lan: mesh.lan_status(bus) };
}

function status() {
	let ctx = context();
	let now = mesh.uptime(), wall = time();
	let local = mesh.read_json(mesh.state + '/local.json', mesh.response_limit);
	let cache = mesh.read_json(mesh.state + '/peers.json', mesh.cache_limit) ?? {};
	let local_age = local?.data?.bridge_mac == ctx.node.bridge_mac ? mesh.age(local, now) : null;
	let peers = [];
	for (let p in slice(ctx.peers, 0, mesh.limit)) {
		if (p.bridge_mac == ctx.node.bridge_mac)
			continue;
		let entry = cache[p.bridge_mac]?.address == p.address ? cache[p.bridge_mac] : null;
		let age = mesh.age(entry, now);
		let status = mesh.on_lan(ctx.lan, p.address) ?
			(entry?.status ?? (entry?.data ? 'fresh' : 'unknown')) : 'unreachable';
		if (status == 'fresh' && (!entry.data || age == null || age >= mesh.ttl))
			status = 'stale';
		let online = status == 'fresh';
		push(peers, { ...p, status, online, age, updated_at: age == null ? null : wall - age,
			data: online ? entry.data : null });
	}
	return {
		local: local_age != null && local_age < mesh.ttl ? local.data : ctx.node,
		local_age, local_updated_at: local_age == null ? null : wall - local_age,
		address: ctx.lan?.address,
		peers, profiles: keys(mesh.profiles(ctx.config))
	};
}

function configuration() {
	let ctx = context();
	let ssids = mesh.local_ssids(ctx.config, ctx.bus);
	return {
		profiles: mesh.local_profiles(ctx.config, ssids), ssids,
		limits: {
			profiles: 17, max_links: 3,
			interval: { min: 30, max: 300, default: 30 },
			ttl: { min: 180, max: 1800, default: 180 }
		}
	};
}

function finish_commit(config, name) {
	if (!config.commit(name))
		return { error: 'save_failed' };
	return mesh.reconcile() ? { saved: true } : { saved: true, error: 'service_reload_failed' };
}

function profile_save(args) {
	let ctx = context(), id = mesh.profile(args.id);
	if (!id)
		return { error: 'invalid_profile_id' };
	let existing = ctx.config.get_all('wrtmesh', id);
	if (existing && existing['.type'] != 'roaming')
		return { error: 'invalid_profile_id' };
	let count = 0;
	ctx.config.foreach('wrtmesh', 'roaming', () => { count++; });
	if (!existing && count >= 17)
		return { error: 'profile_limit' };
	if (type(args.enabled) != 'bool')
		return { error: 'invalid_profile_enabled' };
	if (!mesh.profile_timers(args.interval, args.ttl))
		return { error: 'invalid_profile_timers' };
	let ssids = mesh.local_ssids(ctx.config, ctx.bus);
	let selected = filter(ssids, s => s.section == args.section)[0];
	let unchanged = existing && (existing.section ?? '') == args.section;
	if (!selected && !(!args.enabled && unchanged))
		return { error: 'invalid_profile_section' };
	let explicit = args.metadata != null && length(args.metadata);
	let metadata = explicit ? mesh.profile_metadata(args.metadata.iface, args.metadata.mlo, args.metadata.max_links) :
		selected?.supported ? mesh.profile_metadata(selected.iface, selected.mlo, selected.max_links) : null;
	if (explicit && !metadata)
		return { error: 'profile_metadata_unsupported' };
	if (args.enabled) {
		if (!selected?.available || !selected.supported)
			return { error: selected?.reason ?? 'profile_runtime_unavailable' };
		if (!metadata || metadata.iface != selected.iface || metadata.mlo != selected.mlo ||
		    metadata.max_links < selected.max_links)
			return { error: 'profile_runtime_mismatch' };
		for (let other in mesh.local_profiles(ctx.config, ssids))
			if (other.id != id && other.enabled &&
			    (other.section == args.section || other.iface == metadata.iface))
				return { error: 'duplicate_profile_section' };
		let own = [selected.bssid, ...map(selected.links, link => link.bssid)];
		for (let peer in ctx.peers)
			for (let address in peer.profiles[id] ?? [])
				if (index(own, address) >= 0)
					return { error: 'duplicate_bssid' };
	}
	if (!existing && !ctx.config.set('wrtmesh', id, 'roaming'))
		return { error: 'save_failed' };
	for (let key, value in { enabled: args.enabled ? '1' : '0', interval: args.interval, ttl: args.ttl })
		if (!ctx.config.set('wrtmesh', id, key, sprintf('%s', value)))
			return { error: 'save_failed' };
	if (selected && !ctx.config.set('wrtmesh', id, 'section', selected.section))
		return { error: 'save_failed' };
	if (metadata) {
		for (let key, value in { iface: metadata.iface, mlo: metadata.mlo ? '1' : '0', max_links: metadata.max_links })
			if (!ctx.config.set('wrtmesh', id, key, sprintf('%s', value)))
				return { error: 'save_failed' };
	}
	if (!existing) {
		let approved = [];
		ctx.config.foreach('wrtmesh', 'peer', peer => {
			if (mesh.private_ip(peer.address) && mesh.mac(peer.bridge_mac) && mesh.pins(peer[id + '_bssid']))
				push(approved, peer['.name']);
		});
		if (length(approved) &&
		    (!ctx.config.set('wrtmesh', id, 'peer_mode', 'fleet') || !ctx.config.set('wrtmesh', id, 'peers', approved)))
			return { error: 'save_failed' };
	}
	return finish_commit(ctx.config, 'wrtmesh');
}

function preserve_embedded_peer(config, id) {
	if (config.get('wrtmesh', id, 'peer_mode') == 'fleet')
		return true;
	let address = config.get('wrtmesh', id, 'peer');
	let addr = mesh.mac(config.get('wrtmesh', id, 'peer_mac'));
	let pins = mesh.pins(config.get('wrtmesh', id, 'peer_bssid'));
	if (!mesh.private_ip(address) || !addr || !pins)
		return true;
	let section;
	config.foreach('wrtmesh', 'peer', peer => {
		if (peer.address == address && mesh.mac(peer.bridge_mac) == addr)
			section ??= peer['.name'];
	});
	if (!section) {
		let base = 'peer_' + replace(addr, /:/g, ''), index = 0, count = 0;
		config.foreach('wrtmesh', null, () => { count++; });
		section = base;
		while (config.get('wrtmesh', section) && index <= count)
			section = base + '_' + ++index;
		if (!config.set('wrtmesh', section, 'peer') ||
		    !config.set('wrtmesh', section, 'address', address) ||
		    !config.set('wrtmesh', section, 'bridge_mac', addr))
			return false;
	}
	return !!config.set('wrtmesh', section, id + '_bssid', pins);
}

function profile_remove(args) {
	let ctx = context(), id = mesh.section_id(args.id);
	if (!id || ctx.config.get('wrtmesh', id) != 'roaming')
		return { error: 'profile_not_found' };
	if (!preserve_embedded_peer(ctx.config, id))
		return { error: 'save_failed' };
	if (!ctx.config.delete('wrtmesh', id))
		return { error: 'save_failed' };
	// Peer approvals belong to their peers and remain dormant until this stable
	// profile ID is configured again.
	return finish_commit(ctx.config, 'wrtmesh');
}

function discover() {
	let ctx = context();
	let candidates = {}, pending = false;
	let inspected = 0;
	for (let service in [mesh.service, '_xr-roaming._tcp']) {
		let records = mesh.call(ctx.bus, 'umdns', 'browse', { service, array: true });
		let hosts = records[service] ?? {};
		for (let name in slice(keys(hosts), 0, 32 - inspected)) {
			inspected++;
			let record = hosts[name];
			if (!ctx.lan || record.iface != ctx.lan.device || record.port != 80)
				continue;
			let addresses = type(record.ipv4) == 'string' ? [record.ipv4] : mesh.array(record.ipv4);
			let hostname = type(record.host) == 'string' && (service == mesh.service ?
				match(record.host, /^wrtmesh-[0-9a-f]{12}\.local$/) : match(record.host, /^xr-[0-9a-f]{12}\.local$/));
			if (!length(addresses) && hostname) {
				// A matching SRV can arrive before its A record.
				mesh.call(ctx.bus, 'umdns', 'query', { question: record.host, interface: ctx.lan.device, type: 1 });
				pending = true;
			}
			for (let addr in addresses) {
				if (mesh.on_lan(ctx.lan, addr) && length(candidates) < 32)
					candidates[addr] ??= { address: addr, name: mesh.label(name, 64) || addr };
			}
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
	if (ctx.config.get('wrtmesh_peers', id))
		ctx.config.delete('wrtmesh_peers', id);
	if (peer) {
		if (!ctx.config.set('wrtmesh_peers', id, 'peer') ||
		    !ctx.config.set('wrtmesh_peers', id, 'bridge_mac', addr))
			return { error: 'save_failed' };
		if (peer.disabled) {
			if (!ctx.config.set('wrtmesh_peers', id, 'disabled', '1'))
				return { error: 'save_failed' };
		} else {
			if (!ctx.config.set('wrtmesh_peers', id, 'address', peer.address) ||
			    !ctx.config.set('wrtmesh_peers', id, 'name', peer.name))
				return { error: 'save_failed' };
			for (let profile, bssids in peer.profiles) {
				if (!ctx.config.set('wrtmesh_peers', id, profile + '_bssid', bssids))
					return { error: 'save_failed' };
			}
		}
	}
	return finish_commit(ctx.config, 'wrtmesh_peers');
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

	let supported = mesh.profiles(ctx.config, true);
	let own = mesh.local_profile_bssids(ctx.config, ctx.bus);
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
	wrtmesh: {
		status: { call: status },
		configuration: { call: configuration },
		profile_save: {
			args: { id: '', section: '', enabled: false, interval: 30, ttl: 180, metadata: {} },
			call: req => mutate(profile_save, req.args)
		},
		profile_remove: { args: { id: '' }, call: req => mutate(profile_remove, req.args) },
		discover: { call: discover },
		scan: { call: () => {
			let bus = ubus.connect(null, 1);
			let lan = mesh.lan_status(bus);
			if (!lan)
				return { error: 'lan_unavailable' };
			let queried = false;
			for (let service in [mesh.service, '_xr-roaming._tcp']) {
				let result = bus.call('umdns', 'query', {
					question: service + '.local', interface: lan.device, type: 12
				});
				queried ||= result != null || !ubus.error();
			}
			return queried ? { scanning: true } : { error: 'discovery_unavailable' };
		} },
		identify: { args: { address: '' }, call: req => identify(req.args) },
		save: { args: { address: '', bridge_mac: '', name: '', profiles: {} }, call: req => mutate(save, req.args) },
		remove: { args: { bridge_mac: '' }, call: req => mutate(remove, req.args) }
	}
};
