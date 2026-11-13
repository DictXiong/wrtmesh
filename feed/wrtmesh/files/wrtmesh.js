'use strict';
'require baseclass';
'require rpc';

const getStatus = rpc.declare({ object: 'wrtmesh', method: 'status', raise: true });
const openPaths = new Set();
let cachedStatus, refreshAt = 0;

function nodeName(peer) {
	const name = peer.name || peer.data?.name;
	return name && peer.address ? name + ' (' + peer.address + ')' : name || peer.address || peer.bridge_mac || '?';
}

function stationHint(station, hints, lookup) {
	const aliases = [station.mld, station.mac, ...(station.links || []).map(link => link.mac)];
	for (const mac of new Set(aliases)) {
		const value = typeof mac === 'string' && hints?.[lookup]?.(mac.toUpperCase());
		if (value)
			return value;
	}
	return null;
}

function stationIdentity(station, hints) {
	const stations = Array.isArray(station) ? station : [station];
	const find = (field, lookup) => stations.map(station => station[field] || stationHint(station, hints, lookup)).find(Boolean);
	const name = find('name', 'getHostnameByMACAddr');
	const ipv4 = find('ipv4', 'getIPAddrByMACAddr');
	const ipv6 = find('ipv6', 'getIP6AddrByMACAddr');
	return { name, ipv4, ipv6, label: name || ipv4 || ipv6 || '?' };
}

function distinct(items, value) {
	return [...new Set(items.map(value).filter(value => value != null && value !== ''))];
}

function reportRadio(report) {
	const nr = report?.nr;
	if (typeof nr !== 'string' || !/^[0-9a-f]{26,512}$/i.test(nr) || nr.length % 2)
		return null;
	// The existing neighbor report carries the operating class and channel;
	// unlike a client observation, it describes the advertised AP radio.
	const opclass = parseInt(nr.slice(20, 22), 16);
	const channel = parseInt(nr.slice(22, 24), 16);
	if (!channel || channel > 233)
		return null;
	const band = opclass >= 81 && opclass <= 84 ? _('2.4 GHz') :
		opclass >= 115 && opclass <= 130 ? _('5 GHz') :
		opclass >= 131 && opclass <= 137 ? _('6 GHz') : null;
	return [band || _('Band unknown'), _('Channel %d').format(channel)].join(' · ');
}

function clientCell(label, contents, kind) {
	return E('td', { class: 'td wrtmesh-client-' + kind + '-cell', role: 'cell',
		'data-label': label }, [contents]);
}

function pathText(path) {
	if (!path)
		return _('Path unknown');
	return [
		path.bridge,
		path.port || _('Port unknown'),
		path.medium === 'wireless' ? _('Wireless') : path.medium === 'ethernet' ? _('Ethernet') : null
	].filter(Boolean).join(' / ');
}

function svgElement(tag, attrs, text) {
	const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
	for (const [key, value] of Object.entries(attrs))
		node.setAttribute(key, value);
	if (text != null)
		node.textContent = text;
	return node;
}

function matchesUplink(path, uplink) {
	return path?.medium !== 'wireless' &&
		(!path?.bridge || !uplink.bridge || path.bridge === uplink.bridge) &&
		(!path?.port || path.port === uplink.port);
}

function sharedEthernet(localId, links) {
	const uplinks = new Map(links.filter(link => link.gateway).map(link => [link.from, link]));
	const local = uplinks.get(localId);
	if (!local?.to.startsWith('gateway:') || local.path.medium !== 'ethernet')
		return null;

	const branches = new Map([[localId, local]]);
	let mac = local.path.mac;
	for (const link of links) {
		if (link.gateway)
			continue;
		const peer = uplinks.get(link.to);
		if (peer?.to !== local.to || peer.path.medium !== 'ethernet' ||
		    (mac && peer.path.mac && mac !== peer.path.mac) ||
		    !matchesUplink(link.path, local.path) || !matchesUplink(link.reverse, peer.path))
			continue;
		mac ||= peer.path.mac;
		branches.set(peer.from, peer);
	}
	return branches.size > 1 ? { gateway: local.to, branches } : null;
}

function stationBadge(snapshot) {
	if (!Array.isArray(snapshot?.stations))
		return { text: '—', title: _('Station count unavailable'), unknown: true };
	const count = snapshot.stations.length;
	return snapshot.truncated
		? { text: count + '+', title: _('At least %d associated stations').format(count) }
		: { text: String(count), title: _('Associated stations: %d').format(count) };
}

function diagram(local, peers, gateways, links, bus) {
	const lastBranchY = bus ? 32 + (bus.branches.size - 1) * 62 : 0;
	const otherStartY = Math.max(80, lastBranchY + 62);
	const otherGateways = gateways.filter(gateway => gateway.id !== bus?.gateway);
	let peerRow = 0, branchRow = 1;
	const nodes = [
		{ id: local.bridge_mac, label: local.name || _('This device'),
			subtitle: local.name ? _('This device') : null, badge: stationBadge(local), x: 420, y: 32 },
		...peers.map(peer => {
			const name = peer.name || peer.data?.name;
			const onBus = bus?.branches.has(peer.bridge_mac);
			return { id: peer.bridge_mac, label: name || nodeName(peer), subtitle: name ? peer.address : null,
				badge: stationBadge(peer.data), x: onBus ? 420 : 120,
				y: onBus ? 32 + branchRow++ * 62 : otherStartY + peerRow++ * 62 };
		}),
		...otherGateways.map((gateway, i) => ({ id: gateway.id, label: gateway.address,
			subtitle: _('Gateway'), x: 720, y: otherStartY + i * 62 }))
	];
	if (bus) {
		const gateway = gateways.find(gateway => gateway.id === bus.gateway);
		nodes.push({ id: gateway.id, label: gateway.address, subtitle: _('Gateway'),
			x: 720, y: peerRow ? lastBranchY : (32 + lastBranchY) / 2 });
	}
	const byId = new Map(nodes.map(node => [node.id, node]));
	const left = Math.min(...nodes.map(node => node.x)) - 120;
	const width = Math.max(...nodes.map(node => node.x)) + 120 - left;
	const height = Math.max(...nodes.map(node => node.y)) + 32;
	const picture = svgElement('svg', {
		viewBox: [left, 0, width, height].join(' '), width, height,
		class: 'wrtmesh-map', role: 'img', 'aria-label': _('Mesh topology'),
		style: 'min-width:' + Math.min(400, width) + 'px'
	});
	function line(x1, y1, x2, y2, title, known, shared) {
		const segment = svgElement('line', {
			x1, y1, x2, y2, class: shared ? 'wrtmesh-line wrtmesh-line-shared' : 'wrtmesh-line',
			'stroke-dasharray': known ? 'none' : '5 5'
		});
		segment.appendChild(svgElement('title', {}, title));
		picture.appendChild(segment);
	}
	for (const link of links) {
		if (bus && (link.gateway
			? link.to === bus.gateway && bus.branches.has(link.from)
			: bus.branches.has(link.to)))
			continue;
		const from = byId.get(link.from), to = byId.get(link.to);
		if (!from || !to || from === to)
			continue;
		line(from.x, from.y, to.x, to.y, link.label, !!link.path?.port, false);
	}
	if (bus) {
		const trunkX = 570, gateway = byId.get(bus.gateway);
		line(trunkX, 32, trunkX, lastBranchY, _('Shared Ethernet'), true, true);
		line(trunkX, gateway.y, gateway.x, gateway.y, _('Shared gateway'), true, true);
		for (const [id, uplink] of bus.branches) {
			const node = byId.get(id);
			line(node.x, node.y, trunkX, node.y, uplink.label, !!uplink.path.port, true);
		}
	}
	for (const node of nodes) {
		const group = svgElement('g', {});
		const title = [node.label, node.subtitle, node.badge?.title].filter(Boolean).join(' · ');
		group.appendChild(svgElement('title', {}, title));
		group.appendChild(svgElement('rect', {
			x: node.x - 98, y: node.y - 22, width: 196, height: 44, rx: 8,
			class: node.id === local.bridge_mac ? 'wrtmesh-node wrtmesh-node-local' : 'wrtmesh-node'
		}));
		const textX = node.x - (node.badge ? 20 : 0);
		const limit = node.badge ? 18 : 23;
		group.appendChild(svgElement('text', {
			x: textX, y: node.y - (node.subtitle ? 8 : 0), 'text-anchor': 'middle',
			'dominant-baseline': 'central', class: 'wrtmesh-node-label'
		}, node.label.length > limit ? node.label.slice(0, limit - 1) + '…' : node.label));
		if (node.subtitle)
			group.appendChild(svgElement('text', {
				x: textX, y: node.y + 9, 'text-anchor': 'middle', 'dominant-baseline': 'central',
				class: 'wrtmesh-node-subtitle'
			}, node.subtitle));
		if (node.badge) {
			group.appendChild(svgElement('rect', {
				x: node.x + 50, y: node.y - 12, width: 38, height: 24, rx: 12,
				class: node.badge.unknown ? 'wrtmesh-count wrtmesh-count-unknown' : 'wrtmesh-count'
			}));
			group.appendChild(svgElement('text', {
				x: node.x + 69, y: node.y, 'text-anchor': 'middle', 'dominant-baseline': 'central',
				fill: 'white', 'font-size': 13
			}, node.badge.text));
		}
		picture.appendChild(group);
	}
	picture.appendChild(svgElement('desc', {}, nodes.map(node =>
		[node.label, node.subtitle, node.badge?.title].filter(Boolean).join(' · ')).join('. ')));
	return E('div', { class: 'wrtmesh-diagram' }, picture);
}

function rate(value) {
	// C7 hostapd multiplies the driver's kbit/s rate by 100 in its ubus reply.
	return value == null ? '—' : '%.1f\xa0%s'.format(value / 100000, _('Mbit/s'));
}

function pathDetails(key, title, content) {
	return E('details', {
		class: key === 'local' ? 'wrtmesh-paths' : null,
		open: openPaths.has(key) ? '' : null,
		toggle: event => {
			if (event.currentTarget.open)
				openPaths.add(key);
			else
				openPaths.delete(key);
		}
	}, [E('summary', {}, [title]), ...content]);
}

return baseclass.extend({
	loadStatus(force) {
		const now = Date.now();
		if (force || now >= refreshAt) {
			refreshAt = now + 12000;
			cachedStatus = L.resolveDefault(getStatus(), null);
		}
		return cachedStatus;
	},
	nodeName,

	stylesheet() {
		return E('link', { rel: 'stylesheet', href: L.resource('wrtmesh.css?v=6.4.4') });
	},

	topology(data) {
		const local = data?.local;
		if (!local?.bridge_mac)
			return E('p', {}, _('Mesh status is unavailable.'));
		const peers = data.peers || [];
		const gateways = new Map(), links = [], peerPaths = [];
		const ownName = local.name || _('This device');
		const fromNodes = [{ id: local.bridge_mac, name: ownName, data: local }];
		for (const peer of peers) {
			const path = local.paths?.[peer.bridge_mac];
			const reverse = peer.data?.paths?.[local.bridge_mac];
			links.push({
				from: local.bridge_mac, to: peer.bridge_mac, path, reverse,
				label: ownName + ' ↔ ' + nodeName(peer),
				detail: reverse ? pathText(path) + ' ↔ ' + pathText(reverse) : pathText(path)
			});
			fromNodes.push({ id: peer.bridge_mac, name: nodeName(peer), data: peer.data });
			for (const other of peers) {
				const observed = peer.data?.paths?.[other.bridge_mac];
				if (peer !== other && observed?.port)
					peerPaths.push(E('li', {}, [nodeName(peer), ' → ', nodeName(other), ' · ', pathText(observed)]));
			}
		}
		for (const node of fromNodes) {
			const gateway = node.data?.gateway;
			if (!gateway?.address)
				continue;
			const existing = peers.find(peer => peer.address === gateway.address &&
				(!gateway.mac || gateway.mac === peer.bridge_mac));
			const id = existing?.bridge_mac || (gateway.address === data.address ? local.bridge_mac : null) ||
				'gateway:' + gateway.address;
			if (id.startsWith('gateway:'))
				gateways.set(id, { id, address: gateway.address });
			links.push({ from: node.id, to: id, path: gateway, gateway: true,
				label: node.name + ' → ' + _('Gateway') + ' ' + gateway.address,
				detail: pathText(gateway) });
		}
		const bus = sharedEthernet(local.bridge_mac, links);
		return E('div', { class: 'wrtmesh-topology' }, [
			diagram(local, peers, Array.from(gateways.values()), links, bus),
			links.length ? pathDetails('local', _('Bridge and port details'), [
				E('p', { class: 'cbi-section-descr' }, _('Paths reflect local bridge and port observations. A switch may be between devices.')),
				E('ul', {}, links.map(link => E('li', {}, [
					E('span', {}, [link.label]), E('small', { class: 'wrtmesh-secondary' }, [link.detail])
				]))),
				peerPaths.length ? pathDetails('peer', _('Paths reported between peers'), [E('ul', {}, peerPaths)]) : null
			]) : null
		]);
	},

	stations(data, includeLocal) {
		const rows = [];
		if (includeLocal)
			for (const s of data?.local?.stations || [])
				rows.push({ ...s, node: data.local.name || _('This device'), remote: false });
		for (const peer of data?.peers || [])
			for (const s of peer.data?.stations || [])
				rows.push({ ...s, node: nodeName(peer), remote: true });
		return rows;
	},

	stationNetwork(station, interfaces = []) {
		const kind = station.remote ? _('Mesh peer') : _('This device');
		return E('span', { class: 'ifacebadge wrtmesh-network', title: station.node }, [
			E('img', { src: L.resource('icons/wifi.svg'), alt: '' }),
			E('span', {}, [
				station.ssid || station.iface || '—',
				E('small', { class: 'wrtmesh-secondary' }, [
					[...interfaces, kind, station.node && station.node !== kind ? station.node : null].filter(Boolean).join(' · ')
				])
			])
		]);
	},

	stationHint,
	stationIdentity,

	stationHost(station, hints) {
		const identity = stationIdentity(station, hints);
		const addresses = [identity.ipv4, identity.ipv6].filter(address => address && address !== identity.label);
		const visible = identity.name ? addresses.slice(0, 1) : [];
		return E('span', { class: 'wrtmesh-host', title: addresses.join(', ') || null }, [
			E('span', {}, [identity.label]),
			...visible.map(address => E('small', { class: 'wrtmesh-secondary' }, [address]))
		]);
	},

	// Only formats the caller's observations. Overview owns overlap selection;
	// the Mesh page passes each local/peer record through without deduplication.
	stationTable(stations, hints, options = {}) {
		const headings = [_('Network'), _('MAC address'), _('Host'), _('Signal'), _('Negotiated rate (AP RX / TX)')];
		const bodies = stations.map((station, index) => {
			const observations = station.associations || [station];
			const first = observations[0];
			const ssids = distinct(observations, observation => observation.ssid);
			const interfaces = options.interfaces ? distinct(observations, observation => observation.iface) : [];
			const network = this.stationNetwork({ ...first, ...station, ssid: ssids.join(', ') }, interfaces);
			const overlap = station.otherNodes?.length ? _('Also reported by %s').format(station.otherNodes.join(', ')) : null;
			if (overlap)
				network.title = [network.title, overlap].filter(Boolean).join(' · ');
			const macs = distinct(observations, observation => observation.mac?.toUpperCase());
			const mac = E('span', { class: 'wrtmesh-client-mac' },
				macs.map(address => E('span', { class: 'wrtmesh-client-address' }, [address])));
			return E('tbody', { class: 'wrtmesh-client-entry', role: 'rowgroup',
				'data-client': station.clientKey || JSON.stringify([station.node, first.mac, first.ssid, index]) },
				E('tr', { class: 'tr wrtmesh-client-summary', role: 'row' }, [
					clientCell(headings[0], network, 'network'),
					clientCell(headings[1], mac, 'mac'),
					clientCell(headings[2], this.stationHost(observations, hints), 'host'),
					clientCell(headings[3], this.stationSignal(first.signal), 'signal'),
					clientCell(headings[4], this.stationRates(first, true), 'rates')
				]));
		});
		return E('div', { class: 'wrtmesh-client-list' }, E('table', { class: 'table wrtmesh-client-table',
			role: 'table', 'aria-label': options.label || _('Associated Stations') }, [
			E('thead', { role: 'rowgroup' }, E('tr', { class: 'tr table-titles', role: 'row' },
				headings.map(text => E('th', { class: 'th', scope: 'col', role: 'columnheader' }, [text])))),
			...bodies,
			!bodies.length ? E('tbody', {}, E('tr', { class: 'tr' }, E('td', { class: 'td', colspan: headings.length },
				options.empty || _('No associated stations reported.')))) : null
		]));
	},

	ssidRadios(snapshot, ssid, snapshotAge) {
		const parts = (snapshot?.roaming || []).filter(network => network.ssid === ssid).flatMap(network => network.parts || []);
		const radios = new Map();
		let expired = false;
		if (Number.isFinite(snapshotAge) && snapshotAge >= 0) {
			for (const part of parts) {
				if (!Number.isFinite(part.age) || !Number.isFinite(part.ttl) || part.age < 0 || part.ttl <= 0)
					continue;
				if (snapshotAge + part.age >= part.ttl) {
					expired = true;
					continue;
				}
				for (const report of part.envelope?.reports || []) {
					const label = reportRadio(report);
					if (label && typeof report.bssid === 'string')
						radios.set(report.bssid.toLowerCase(), label);
				}
			}
		}
		const counts = new Map();
		for (const label of radios.values())
			counts.set(label, (counts.get(label) || 0) + 1);
		const labels = Array.from(counts, ([label, count]) => count > 1 ? label + ' ×' + count : label);
		if (expired)
			labels.push(labels.length ? _('Some radio information expired') : _('Radio information expired'));
		return E('span', { class: 'wrtmesh-ssid-radios', 'data-state': expired ? 'stale' : labels.length ? 'fresh' : 'unavailable' },
			labels.join(' / ') || _('Radio information unavailable'));
	},

	stationSignal(value) {
		if (!Number.isFinite(value) || value < -127 || value >= 0)
			return E('span', {}, ['—']);
		const quality = Math.max(0, Math.min(100, (value + 110) / 70 * 100));
		const icon = quality === 0 ? '000-000' : quality < 25 ? '000-025' :
			quality < 50 ? '025-050' : quality < 75 ? '050-075' : '075-100';
		return E('span', { class: 'ifacebadge wrtmesh-signal', 'data-signal': value }, [
			E('img', { src: L.resource('icons/signal-' + icon + '.svg'), alt: '' }),
			E('span', {}, ['%d\xa0%s'.format(value, _('dBm'))])
		]);
	},

	stationRates(station, apView) {
		return E('span', { class: 'wrtmesh-rates' }, [
			E('span', { title: apView ? _('AP RX rate') : _('RX Rate') }, [rate(station.rx)]),
			E('span', { title: apView ? _('AP TX rate') : _('TX Rate') }, [rate(station.tx)])
		]);
	}
});
