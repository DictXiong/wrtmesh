'use strict';
'require baseclass';
'require network';
'require rpc';
'require wrtmesh';

const checkAccess = rpc.declare({
	object: 'session', method: 'access', params: ['scope', 'object', 'function'],
	expect: { access: false }, raise: true
});

function snapshotState(peer) {
	return peer.status || (peer.online && peer.data ? 'fresh' : 'unknown');
}

function identity(station, peer) {
	if (station.mld)
		return 'mld:' + station.mld;

	// An exact station MAC can resolve overlap within one ESS. An unknown
	// SSID gives us no basis for deduplicating the station across nodes.
	return JSON.stringify([station.mac, station.ssid || null, station.ssid ? null : peer]);
}

function groupClients(data) {
	const groups = (data.peers || []).map(peer => ({
		peer, name: wrtmesh.nodeName(peer), clients: [], overlaps: 0
	}));
	const byIdentity = new Map();

	function collect(stations, age, group) {
		for (const station of stations || []) {
			const key = identity(station, group?.peer.bridge_mac);
			if (!byIdentity.has(key))
				byIdentity.set(key, []);
			byIdentity.get(key).push({
				station, age: Number.isFinite(age) ? age : Infinity, group
			});
		}
	}

	collect(data.local?.stations, data.local_age, null);
	for (const group of groups)
		if (snapshotState(group.peer) === 'fresh')
			collect(group.peer.data?.stations, group.peer.age, group);

	for (const [key, observations] of byIdentity) {
		// Keep one AP's links from the newest observation. Older publishers
		// lack a sample age, so their age falls back to receiver observation.
		observations.sort((a, b) => {
			if (a.age !== b.age)
				return a.age - b.age;
			return Number(!!a.group) - Number(!!b.group) ||
				(a.group?.peer.bridge_mac || '').localeCompare(b.group?.peer.bridge_mac || '');
		});
		const chosen = observations[0];
		const others = new Set(observations.slice(1).map(entry => entry.group));
		others.delete(chosen.group);
		for (const group of others)
			if (group)
				group.overlaps++;

		chosen.group?.clients.push({
			key,
			associations: observations.filter(entry => entry.group === chosen.group).map(entry => entry.station),
			otherNodes: Array.from(others, group => group?.name || _('This device'))
		});
	}

	return groups.sort((a, b) => a.name.localeCompare(b.name));
}

function updated(peer) {
	const age = Number.isFinite(peer.age) ? _('%d seconds ago').format(peer.age) : null;
	if (!Number.isFinite(peer.updated_at))
		return age ? E('span', {}, [_('Snapshot updated %s').format(age)]) : null;
	const date = new Date(peer.updated_at * 1000);
	return E('time', { datetime: date.toISOString(), title: date.toLocaleString() }, [
		_('Snapshot updated %s').format(age || date.toLocaleString())
	]);
}

function renderGroup(group) {
	const peer = group.peer;
	let status = snapshotState(peer);
	if (status === 'fresh' && !group.clients.length)
		status = group.overlaps ? 'overlap' : 'empty';
	const labels = {
		fresh: _('Fresh peer snapshot'),
		empty: _('No peer wireless clients'),
		overlap: _('Clients also reported by another node'),
		stale: _('Peer snapshot expired'),
		unreachable: _('Peer is unreachable'),
		forbidden: _('Peer denied snapshot access'),
		unavailable: _('Peer snapshot is unavailable'),
		unknown: _('Waiting for a peer snapshot')
	};
	return E('section', { class: 'wrtmesh-client-group', 'data-peer': peer.bridge_mac }, [
		E('h5', {}, [group.name]),
		E('p', { class: 'wrtmesh-client-state cbi-section-descr', 'data-state': status }, [
			E('span', {}, [labels[status] || labels.unknown]), updated(peer),
			status === 'fresh' && group.overlaps ? E('span', {}, [
				_('%d overlapping client observations hidden').format(group.overlaps)
			]) : null
		]),
		peer.data?.truncated ? E('p', { class: 'cbi-section-descr' },
			_('A node reached its station reporting limit.')) : null
	]);
}

return baseclass.extend({
	title: _('Mesh'),

	async load() {
		const data = await wrtmesh.loadStatus();
		if (!data) {
			const allowed = await L.resolveDefault(checkAccess('ubus', 'wrtmesh', 'status'), null);
			return { error: allowed === false ? 'forbidden' : 'unavailable' };
		}

		const hasClients = (data.peers || []).some(peer =>
			snapshotState(peer) === 'fresh' && peer.data?.stations?.length);
		return {
			data,
			hints: hasClients ? await L.resolveDefault(network.getHostHints(), null) : null
		};
	},

	render(result) {
		if (!result?.data) {
			const error = result?.error || 'unavailable';
			return E('p', { class: 'wrtmesh-client-state', 'data-state': error },
				error === 'forbidden' ? _('Permission to view Mesh status was denied.') : _('Mesh status is unavailable.'));
		}

		const groups = groupClients(result.data);
		const clients = groups.flatMap(group => group.clients.map(client => ({
			...client.associations[0], associations: client.associations, clientKey: client.key,
			remote: true, node: group.name, otherNodes: client.otherNodes
		})));

		return E('div', { class: 'wrtmesh-overview' }, [
			wrtmesh.stylesheet(),
			E('h4', {}, _('Mesh topology')),
			wrtmesh.topology(result.data),
			E('h4', {}, _('Peer wireless clients')),
			groups.some(group => group.clients.length) ? E('p', { class: 'cbi-section-descr' },
				_('AP RX is from the client. AP TX is to the client. Rates are negotiated link rates.')) : null,
			groups.length ? E('div', { class: 'wrtmesh-client-statuses' }, groups.map(renderGroup)) :
				E('p', { class: 'wrtmesh-client-state', 'data-state': 'no-peers' }, _('No peers configured.')),
			clients.length ? wrtmesh.stationTable(clients, result.hints, { label: _('Peer wireless clients') }) : null
		].flat());
	}
});
