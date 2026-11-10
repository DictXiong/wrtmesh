'use strict';
'require baseclass';
'require network';
'require rpc';
'require xrmesh';

const checkAccess = rpc.declare({
	object: 'session', method: 'access', params: ['scope', 'object', 'function'],
	expect: { access: false }, raise: true
});

const openClients = new Set();

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
		peer, name: xrmesh.nodeName(peer), clients: [], overlaps: 0
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

function clientLinks(station) {
	return station.links?.length ? station.links : [station];
}

function linkName(link) {
	let band = null;
	if (link.freq >= 2400 && link.freq < 2500)
		band = _('2.4 GHz');
	else if (link.freq >= 4900 && link.freq < 5925)
		band = _('5 GHz');
	else if (link.freq >= 5925 && link.freq <= 7125)
		band = _('6 GHz');
	else if (link.freq >= 57000 && link.freq <= 71000)
		band = _('60 GHz');

	return [band, link.id != null ? _('Link %d').format(link.id) : null].filter(Boolean).join(' · ') || '—';
}

function hostHint(station, hints, lookup) {
	if (!hints)
		return null;
	const macs = new Set([station.mld, station.mac, ...clientLinks(station).map(link => link.mac)]);
	for (const mac of macs) {
		const value = mac && hints[lookup]?.(mac.toUpperCase());
		if (value)
			return value;
	}
	return null;
}

function fields(items) {
	return E('dl', { class: 'wrtmesh-client-fields' }, items
		.filter(([, value]) => value != null && value !== '')
		.flatMap(([label, value]) => [E('dt', {}, [label]), E('dd', {}, [String(value)])]));
}

function unique(items, value) {
	return [...new Set(items.map(value).filter(Boolean))];
}

function clientDetails(client, links, hints) {
	const stations = client.associations;
	const name = stations.map(station => station.name || hostHint(station, hints, 'getHostnameByMACAddr')).find(Boolean);
	const macs = unique(stations, station => station.mac.toUpperCase());
	const details = fields([
		[_('IPv4 address'), unique(stations, station =>
			station.ipv4 || hostHint(station, hints, 'getIPAddrByMACAddr')).join(', ')],
		[_('IPv6 address'), unique(stations, station =>
			station.ipv6 || hostHint(station, hints, 'getIP6AddrByMACAddr')).join(', ')],
		[_('MAC address'), macs.join(', ')],
		[_('MLD address'), stations[0].mld?.toUpperCase()],
		[_('Wireless interface'), unique(stations, station => station.iface).join(', ')]
	]);
	const linkDetails = links
		.filter(link => link.ap_mld || link.bssid || link.channel != null ||
			link.freq != null || (link.mac && !macs.includes(link.mac.toUpperCase())))
		.map(link => E('div', { class: 'wrtmesh-client-link-detail' }, [
			E('strong', {}, [link.label]),
			fields([
				[_('MAC address'), link.mac && !macs.includes(link.mac.toUpperCase()) ? link.mac.toUpperCase() : null],
				[_('AP MLD address'), link.ap_mld?.toUpperCase()],
				[_('BSSID'), link.bssid?.toUpperCase()],
				[_('Channel'), link.channel],
				[_('Frequency'), link.freq != null ? '%d %s'.format(link.freq, _('MHz')) : null]
			])
		]));
	return E('details', {
		class: 'wrtmesh-client-details', open: openClients.has(client.key) ? '' : null,
		toggle: event => {
			if (event.currentTarget.open)
				openClients.add(client.key);
			else
				openClients.delete(client.key);
		}
	}, [
		E('summary', { title: _('Client details') }, [name || '?']),
		details,
		...linkDetails,
		client.otherNodes.length ? E('p', { class: 'wrtmesh-secondary' }, [
			_('Also reported by %s').format(client.otherNodes.join(', '))
		]) : null
	]);
}

function clientCell(title, contents) {
	return E('td', { class: 'td', role: 'cell' }, [
		E('span', { class: 'wrtmesh-client-mobile-label', 'aria-hidden': 'true' }, [title]),
		contents
	]);
}

function clientTable(group, hints) {
	const headings = [_('Client name'), _('SSID'), _('Band / MLO link'), _('Signal'), _('Negotiated rate (AP RX / TX)')];
	const rows = group.clients.map(client => {
		const ssids = unique(client.associations, station => station.ssid);
		const links = client.associations.flatMap(station => clientLinks(station).map(link => ({
			...link, ap_mld: station.ap_mld,
			label: ssids.length > 1 && station.ssid ? linkName(link) + ' · ' + station.ssid : linkName(link)
		})));
		const linkRows = render => E('div', { class: 'wrtmesh-client-link-list' },
			links.map(link => E('div', {}, [render(link)])));
		return E('tr', { class: 'tr', role: 'row', 'data-client': client.key }, [
			clientCell(headings[0], clientDetails(client, links, hints)),
			clientCell(headings[1], E('span', {}, [ssids.join(', ') || '—'])),
			clientCell(headings[2], linkRows(link => link.label)),
			clientCell(headings[3], linkRows(link => xrmesh.stationSignal(link.signal))),
			clientCell(headings[4], linkRows(link => xrmesh.stationRates(link, true)))
		]);
	});
	return E('table', { class: 'table wrtmesh-client-table', role: 'table', 'aria-label': group.name }, [
		E('thead', { role: 'rowgroup' }, E('tr', { class: 'tr table-titles', role: 'row' },
			headings.map(text => E('th', { class: 'th', scope: 'col', role: 'columnheader' }, [text])))),
		E('tbody', { role: 'rowgroup' }, rows)
	]);
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

function renderGroup(group, hints) {
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
		group.clients.length ? clientTable(group, hints) : null,
		peer.data?.truncated ? E('p', { class: 'cbi-section-descr' },
			_('A node reached its station reporting limit.')) : null
	]);
}

return baseclass.extend({
	title: _('Mesh'),

	async load() {
		const data = await xrmesh.loadStatus();
		if (!data) {
			const allowed = await L.resolveDefault(checkAccess('ubus', 'xrmesh', 'status'), null);
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
		const visibleKeys = new Set(groups.flatMap(group => group.clients.map(client => client.key)));
		for (const key of openClients)
			if (!visibleKeys.has(key))
				openClients.delete(key);

		return E('div', { class: 'wrtmesh-overview' }, [
			xrmesh.stylesheet(),
			E('h4', {}, _('Mesh topology')),
			xrmesh.topology(result.data),
			E('h4', {}, _('Peer wireless clients')),
			groups.some(group => group.clients.length) ? E('p', { class: 'cbi-section-descr' },
				_('AP RX is from the client. AP TX is to the client. Rates are negotiated link rates.')) : null,
			groups.length ? groups.map(group => renderGroup(group, result.hints)) :
				E('p', { class: 'wrtmesh-client-state', 'data-state': 'no-peers' }, _('No peers configured.'))
		].flat());
	}
});
