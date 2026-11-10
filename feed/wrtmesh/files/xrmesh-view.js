'use strict';
'require view';
'require rpc';
'require poll';
'require ui';
'require xrmesh';

const discover = rpc.declare({ object: 'xrmesh', method: 'discover' });
const scan = rpc.declare({ object: 'xrmesh', method: 'scan' });
const identify = rpc.declare({ object: 'xrmesh', method: 'identify', params: ['address'] });
const savePeer = rpc.declare({
	object: 'xrmesh', method: 'save', params: ['address', 'bridge_mac', 'name', 'profiles']
});
const removePeer = rpc.declare({ object: 'xrmesh', method: 'remove', params: ['bridge_mac'] });
const access = rpc.declare({
	object: 'session', method: 'access', params: ['scope', 'object', 'function'], expect: { access: false }
});

function result(response) {
	if (!response?.error)
		return response;
	const errors = {
		invalid_peer: _('Enter a unicast bridge MAC and a peer IPv4 address on the LAN subnet.'),
		peer_limit: _('This device already has 15 peers.'),
		duplicate_address: _('This address is already used by another peer.'),
		invalid_bssid: _('Enter up to three distinct unicast BSSIDs for each roaming profile.'),
		duplicate_bssid: _('A BSSID is already used by this device or another peer on this profile.'),
		save_failed: _('Could not save the local peer settings.'),
		identity_unavailable: _('The peer did not return a valid Mesh identity. You can enter its details manually.'),
		lan_unavailable: _('The management LAN is unavailable.'),
		discovery_unavailable: _('The mDNS discovery service is unavailable.')
	};
	throw new Error(errors[response.error] || _('Mesh request failed.'));
}

function input(type, value, attributes) {
	return E('input', { type, value: value || '', class: 'cbi-input-text', ...attributes });
}

function field(label, element) {
	return E('label', { style: 'display:block;margin:0.75em 0' }, [label, E('br'), element]);
}

function table(headers, rows, empty) {
	const table = E('table', { class: 'table' }, [
		E('tr', { class: 'tr table-titles' }, headers.map(title => E('th', { class: 'th' }, title)))
	]);
	cbi_update_table(table, rows, E('em', {}, empty));
	return E('div', { class: 'wrtmesh-table' }, table);
}

const cell = text => E('span', {}, [String(text ?? '—')]);

function section(title, content) {
	return E('section', { class: 'cbi-section wrtmesh-section' }, [
		E('h3', {}, [title]), ...content
	]);
}

return view.extend({
	handleSaveApply: null,
	handleSave: null,
	handleReset: null,

	load() {
		return Promise.all([xrmesh.loadStatus(), L.resolveDefault(access('ubus', 'xrmesh', 'save'), false)]);
	},

	notify(error) {
		ui.addNotification(null, E('p', {}, [error.message]), 'error');
	},

	action(fn) {
		return ui.createHandlerFn(this, () => fn().catch(error => this.notify(error)));
	},

	refresh(force) {
		return xrmesh.loadStatus(force).then(data => {
			this.data = data;
			this.content.replaceChildren(this.sections(data));
		});
	},

	editor(peer, discovered) {
		const address = input('text', peer?.address, { maxlength: 15 });
		const mac = input('text', peer?.bridge_mac, { maxlength: 17, readonly: peer && !discovered ? '' : null });
		const name = input('text', peer?.name, { maxlength: 64 });
		const profiles = Object.fromEntries((this.data?.profiles || []).map(id => {
			const pins = peer?.profiles?.[id];
			return [id, input('text', Array.isArray(pins) ? pins.join(', ') : '', { maxlength: 60 })];
		}));
		ui.showModal(_('Mesh peer'), [
			discovered ? E('p', {}, _('Verify the bridge MAC and BSSIDs before saving this discovered peer. Discovery is unauthenticated.')) : null,
			field(_('Peer IPv4 address'), address),
			field(_('Bridge MAC address'), mac),
			field(_('Display name'), name),
			...Object.entries(profiles).map(([id, node]) => field(_('BSSIDs for %s (optional)').format(id), node)),
			E('p', {}, _('A peer can share station status without BSSIDs. Roaming uses only the BSSIDs approved here.')),
			E('div', { class: 'right' }, [
				E('button', { class: 'btn', click: ui.hideModal }, _('Cancel')),
				' ',
				E('button', { class: 'btn cbi-button-positive', click: this.action(async () => {
					const pins = Object.fromEntries(Object.entries(profiles).map(([id, node]) => [id, node.value]));
					result(await savePeer(address.value.trim(), mac.value.trim(), name.value, pins));
					ui.hideModal();
					await this.refresh(true);
				}) }, _('Save peer'))
			])
		].filter(Boolean));
	},

	async search() {
		result(await scan());
		await new Promise(resolve => window.setTimeout(resolve, 900));
		let data = result(await discover());
		if (data?.pending) {
			await new Promise(resolve => window.setTimeout(resolve, 700));
			data = result(await discover());
		}
		const existing = new Set((this.data?.peers || []).map(p => p.address));
		const rows = (data?.candidates || []).filter(p => !existing.has(p.address)).map(p => [
			cell(p.name), cell(p.address),
			E('button', { class: 'btn', click: this.action(async () => {
				const { peer } = result(await identify(p.address));
				const known = (this.data?.peers || []).find(p => p.bridge_mac === peer.bridge_mac);
				if (known) {
					peer.name = known.name || peer.name;
					peer.profiles = { ...peer.profiles, ...known.profiles };
				}
				this.editor(peer, true);
			}) }, _('Review'))
		]);
		ui.showModal(_('Discovered peers'), [
			table([_('Name'), _('IPv4 address'), ''], rows, _('No new peers discovered on the management LAN.')),
			E('div', { class: 'right' }, [E('button', { class: 'btn', click: ui.hideModal }, _('Close'))])
		]);
	},

	confirmRemove(peer) {
		ui.showModal(_('Remove peer'), [
			E('p', {}, [_('Remove this peer from this device?'), ' ', xrmesh.nodeName(peer)]),
			E('div', { class: 'right' }, [
				E('button', { class: 'btn', click: ui.hideModal }, _('Cancel')),
				' ',
				E('button', { class: 'btn cbi-button-negative', click: this.action(async () => {
					result(await removePeer(peer.bridge_mac));
					ui.hideModal();
					await this.refresh(true);
				}) }, _('Remove peer'))
			])
		]);
	},

	sections(data) {
		const peers = (data?.peers || []).map(p => {
			const status = p.online ? _('Online') : _('No fresh snapshot');
			const row = [cell(p.name || p.data?.name), cell(p.address), cell(p.bridge_mac.toUpperCase()),
				E('span', { class: p.online ? 'wrtmesh-peer-status wrtmesh-online' : 'wrtmesh-peer-status' }, [status]),
				cell(Object.keys(p.profiles).join(', ') || '—')];
			if (this.writable)
				row.push(E('div', { class: 'wrtmesh-actions' }, [
					E('button', { class: 'btn', click: () => this.editor(p, false) }, _('Edit')), ' ',
					E('button', { class: 'btn cbi-button-negative', click: () => this.confirmRemove(p) }, _('Remove peer'))
				]));
			return row;
		});
		const headers = [_('Name'), _('IPv4 address'), _('Bridge MAC'), _('Peer status'), _('Roaming profiles')];
		if (this.writable)
			headers.push('');
		const stationRows = xrmesh.stations(data, true).map(s => [
			xrmesh.stationNetwork(s), cell(s.mac.toUpperCase()), xrmesh.stationHost(s),
			xrmesh.stationSignal(s.signal), xrmesh.stationRates(s)
		]);
		const truncated = data?.local?.truncated || data?.peers?.some(peer => peer.data?.truncated);
		return E('div', {}, [
			section(_('Mesh peers'), [table(headers, peers, _('No peers configured.'))]),
			section(_('Mesh topology'), [xrmesh.topology(data)]),
			section(_('Associated Stations'), [
				truncated ? E('p', { class: 'cbi-section-descr' }, _('A node reached its station reporting limit.')) : null,
				table([_('Network'), _('MAC address'), _('Host'), _('Signal'),
					'%s / %s'.format(_('RX Rate'), _('TX Rate'))], stationRows, _('No associated stations reported.'))
			])
		]);
	},

	render([data, writable]) {
		this.data = data;
		this.writable = writable;
		this.content = E('div', {}, this.sections(data));
		poll.add(() => this.refresh().catch(error => this.notify(error)), 15);
		return E('div', { class: 'cbi-map' }, [
			xrmesh.stylesheet(),
			E('div', { class: 'wrtmesh-header' }, [
				E('h2', {}, _('Mesh')),
				writable ? E('div', { class: 'wrtmesh-actions' }, [
					E('button', { class: 'btn cbi-button-action', click: this.action(() => this.search()) }, _('Discover peers')),
					E('button', { class: 'btn cbi-button-add', click: () => this.editor(null, false) }, _('Add Mesh peer'))
				]) : null
			]),
			E('p', { class: 'cbi-section-descr' }, _('Add the peer on both devices to exchange station and topology snapshots. Peer changes apply to this device.')),
			this.content
		]);
	}
});
