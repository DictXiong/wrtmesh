'use strict';
'require baseclass';
'require rpc';

const getStatus = rpc.declare({ object: 'xrmesh', method: 'status' });
let cachedStatus, refreshAt = 0;

function nodeName(peer) {
	const name = peer.name || peer.data?.name;
	return name && peer.address ? name + ' (' + peer.address + ')' : name || peer.address || peer.bridge_mac || '?';
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

function diagram(local, peers, gateways, links) {
	const nodes = [
		{ id: local.bridge_mac, label: local.name || _('This device'), x: 420, y: 25 },
		...peers.map((peer, i) => ({ id: peer.bridge_mac, label: nodeName(peer), x: 120, y: 68 + i * 44 })),
		...gateways.map((gateway, i) => ({ id: gateway.id, label: gateway.address, x: 720, y: 68 + i * 44 }))
	];
	const byId = new Map(nodes.map(node => [node.id, node]));
	const picture = svgElement('svg', {
		viewBox: '0 0 840 ' + (Math.max(peers.length, gateways.length, 1) * 44 + 44),
		width: '840', role: 'img', 'aria-label': _('Mesh topology'), style: 'max-width:100%;height:auto'
	});
	for (const link of links) {
		const from = byId.get(link.from), to = byId.get(link.to);
		if (!from || !to || from === to)
			continue;
		const line = svgElement('line', {
			x1: from.x, y1: from.y, x2: to.x, y2: to.y, stroke: 'currentColor',
			'stroke-dasharray': link.path?.port ? 'none' : '5 5'
		});
		line.appendChild(svgElement('title', {}, link.label));
		picture.appendChild(line);
	}
	for (const node of nodes) {
		const group = svgElement('g', {});
		group.appendChild(svgElement('rect', {
			x: node.x - 98, y: node.y - 17, width: 196, height: 34, rx: 6,
			fill: 'Canvas', stroke: 'currentColor'
		}));
		group.appendChild(svgElement('text', {
			x: node.x, y: node.y, 'text-anchor': 'middle', 'dominant-baseline': 'central',
			fill: 'currentColor', 'font-size': 14
		}, node.label.length > 23 ? node.label.slice(0, 22) + '…' : node.label));
		group.appendChild(svgElement('title', {}, node.label));
		picture.appendChild(group);
	}
	return picture;
}

return baseclass.extend({
	status(force) {
		const now = Date.now();
		if (force || now >= refreshAt) {
			refreshAt = now + 12000;
			cachedStatus = L.resolveDefault(getStatus(), null);
		}
		return cachedStatus;
	},
	nodeName,

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
				from: local.bridge_mac, to: peer.bridge_mac, path,
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
			links.push({ from: node.id, to: id, path: gateway,
				label: node.name + ' → ' + _('Gateway') + ' ' + gateway.address,
				detail: pathText(gateway) });
		}
		return E('div', {}, [
			diagram(local, peers, Array.from(gateways.values()), links),
			links.length ? E('p', {}, _('Paths reflect local bridge and port observations. A switch may be between devices.')) : null,
			E('ul', {}, links.map(link => E('li', {}, [link.label, ' · ', link.detail]))),
			peerPaths.length ? E('details', {}, [
				E('summary', {}, _('Paths reported between peers')), E('ul', {}, peerPaths)
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

	signal(value) {
		return value == null ? '—' : '%d %s'.format(value, _('dBm'));
	},

	rate(station) {
		const format = rate => rate == null ? '—' : '%.1f'.format(rate / 1000);
		return format(station.rx) + ' / ' + format(station.tx) + ' ' + _('Mbit/s');
	}
});
