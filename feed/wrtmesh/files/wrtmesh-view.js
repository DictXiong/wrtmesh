'use strict';
'require view';
'require rpc';
'require poll';
'require ui';
'require wrtmesh';
'require network';

const discover = rpc.declare({ object: 'wrtmesh', method: 'discover' });
const scan = rpc.declare({ object: 'wrtmesh', method: 'scan' });
const identify = rpc.declare({ object: 'wrtmesh', method: 'identify', params: ['address'] });
const savePeer = rpc.declare({
	object: 'wrtmesh', method: 'peer_save', params: ['address', 'bridge_mac', 'name', 'ssids'], raise: true
});
const removePeer = rpc.declare({ object: 'wrtmesh', method: 'remove', params: ['bridge_mac'] });
const getConfiguration = rpc.declare({ object: 'wrtmesh', method: 'configuration', raise: true });
const saveNetwork = rpc.declare({
	object: 'wrtmesh', method: 'network_save', params: ['section', 'enabled', 'interval', 'ttl'], raise: true
});
const access = rpc.declare({
	object: 'session', method: 'access', params: ['scope', 'object', 'function'], expect: { access: false }
});

async function loadConfiguration() {
	const data = await L.resolveDefault(getConfiguration(), null);
	if (data && (Array.isArray(data.networks) || (Array.isArray(data.profiles) && Array.isArray(data.ssids))))
		return { data };
	const allowed = await L.resolveDefault(access('ubus', 'wrtmesh', 'configuration'), null);
	return { error: allowed === false ? 'forbidden' : 'unavailable' };
}

function result(response) {
	if (!response?.error)
		return response;
	const errors = {
		invalid_peer: _('Enter a unicast bridge MAC and a peer IPv4 address on the LAN subnet.'),
		peer_limit: _('This device already has 15 peers.'),
		duplicate_address: _('This address is already used by another peer.'),
		invalid_ssid: _('Select an SSID configured on this device.'),
		ambiguous_ssid: _('This SSID has multiple local AP configurations. Check the wireless settings.'),
		duplicate_bssid: _('Peer wireless identity conflicts with this device or another peer.'),
		save_failed: _('Could not save the local Mesh settings.'),
		rollback_failed: _('Some local settings changed, but the previous settings could not be restored. Refresh and check the settings.'),
		identity_unavailable: _('The peer did not return a valid Mesh identity. You can enter its details manually.'),
		lan_unavailable: _('The management LAN is unavailable.'),
		discovery_unavailable: _('The mDNS discovery service is unavailable.'),
		invalid_profile_id: _('Could not prepare local wireless settings.'),
		profile_limit: _('This device already has 17 local wireless networks configured for roaming.'),
		profile_not_found: _('The local wireless settings changed. Refresh the page.'),
		invalid_profile_section: _('Select a local AP SSID.'),
		invalid_profile_enabled: _('Choose whether roaming assistance is enabled for this local SSID.'),
		profile_runtime_unavailable: _('Bring the selected AP online before enabling roaming assistance.'),
		profile_runtime_ambiguous: _('The selected SSID has an ambiguous AP interface. Check its wireless configuration.'),
		profile_runtime_mismatch: _('The AP interface changed. Refresh the page and select the local SSID again.'),
		profile_metadata_unsupported: _('This AP interface is not supported for roaming assistance.'),
		invalid_profile_timers: _('Use a check interval from 30 to 300 seconds and an expiry from 180 to 1800 seconds, at least three times the interval.'),
		duplicate_profile_section: _('This SSID already uses another local roaming controller.'),
		config_busy: _('Another configuration edit is in progress. Apply or discard the pending wrtmesh changes before retrying.'),
		service_reload_failed: _('Settings were saved, but the roaming service could not reload. Check the service status.')
	};
	const error = new Error(errors[response.error] || _('Mesh request failed.'));
	error.saved = response.saved === true;
	throw error;
}

function input(type, value, attributes) {
	return E('input', { type, value: value || '', class: type === 'checkbox' ? 'cbi-input-checkbox' : 'cbi-input-text', ...attributes });
}

function field(label, element) {
	element.setAttribute('aria-label', label);
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

	async load() {
		const values = await Promise.all([
			wrtmesh.loadStatus(),
			L.resolveDefault(access('ubus', 'wrtmesh', 'peer_save'), false),
			loadConfiguration(),
			L.resolveDefault(access('ubus', 'wrtmesh', 'network_save'), false)
		]);
		const data = values[0];
		const hasClients = data?.local?.stations?.length || data?.peers?.some(peer => peer.data?.stations?.length);
		this.hostHints = hasClients ? await L.resolveDefault(network.getHostHints(), null) : null;
		return values;
	},

	notify(error) {
		ui.addNotification(null, E('p', {}, [error.message]), 'error');
	},

	action(fn) {
		return ui.createHandlerFn(this, () => fn().catch(async error => {
			if (error.saved) {
				ui.hideModal();
				await this.refresh(true);
			}
			this.notify(error);
		}));
	},

	async refresh(force) {
		const data = await wrtmesh.loadStatus(force);
		if (force) {
			const configuration = await loadConfiguration();
			this.configuration = configuration.data;
			this.configurationError = configuration.error;
		}
		this.data = data;
		this.content.replaceChildren(this.sections(data));
	},

	networks() {
		if (Array.isArray(this.configuration?.networks))
			return this.configuration.networks;
		return (this.configuration?.ssids || []).map(network => ({
			...network,
			...(this.configuration?.profiles?.find(profile => profile.section === network.section) || {})
		}));
	},

	networkEditor(network) {
		const limits = this.configuration?.limits || {};
		const enabled = input('checkbox', '', { checked: network.enabled ? '' : null });
		const interval = input('number', network.interval ?? limits.interval?.default ?? 30, {
			required: '', min: limits.interval?.min ?? 30, max: limits.interval?.max ?? 300, step: 1
		});
		const ttl = input('number', network.ttl ?? limits.ttl?.default ?? 180, {
			required: '', min: limits.ttl?.min ?? 180, max: limits.ttl?.max ?? 1800, step: 1
		});
		ui.showModal(_('Local wireless network'), [
			E('p', {}, [network.ssid || _('SSID unavailable')]),
			field(_('Enable roaming assistance for this local SSID'), enabled),
			E('details', { class: 'wrtmesh-network-advanced' }, [
				E('summary', {}, [_('Advanced settings')]),
				field(_('Check interval (seconds)'), interval),
				field(_('Neighbor report expiry (seconds)'), ttl),
				E('p', { class: 'cbi-section-descr' }, _('Expiry must be at least three times the check interval.'))
			]),
			E('div', { class: 'right wrtmesh-actions' }, [
				E('button', { class: 'btn', click: ui.hideModal }, _('Cancel')),
				E('button', { class: 'btn cbi-button-positive', click: this.action(async () => {
					for (const node of [interval, ttl])
						if (!node.reportValidity())
							return;
					if (Number(ttl.value) < 3 * Number(interval.value))
						throw new Error(_('Expiry must be at least three times the check interval.'));
					result(await saveNetwork(network.section, enabled.checked, Number(interval.value), Number(ttl.value)));
					ui.hideModal();
					await this.refresh(true);
				}) }, _('Save network settings'))
			])
		]);
	},

	localNetworks() {
		if (!this.configuration)
			return section(_('Local wireless networks'), [
				E('p', { class: 'cbi-section-descr', 'data-state': this.configurationError },
					this.configurationError === 'forbidden' ? _('Permission to view local roaming settings was denied.') :
						_('Local roaming settings are unavailable.'))
			]);
		const rows = this.networks().map(network => {
			const row = [
				cell(network.ssid || _('SSID unavailable')),
				cell(network.enabled ? _('Enabled') : _('Disabled')),
				cell(!network.available ? _('AP unavailable') :
					network.supported === false ? _('Radio information unavailable') : network.mlo ? _('MLO, up to %d links').format(network.max_links) : _('Single link'))
			];
			if (this.networkWritable)
				row.push(E('button', { class: 'btn', click: () => this.networkEditor(network) }, _('Settings')));
			return row;
		});
		const headers = [_('SSID'), _('Local collection'), _('Radio links')];
		if (this.networkWritable)
			headers.push('');
		return section(_('Local wireless networks'), [
			E('p', { class: 'cbi-section-descr' }, _('Select SSIDs in each peer to enable roaming assistance. The required local network settings are prepared automatically.')),
			table(headers, rows, _('No local AP SSIDs configured.'))
		]);
	},

	roamingStatus(data) {
		const states = {
			active: _('Roaming enabled'), pending: _('Preparing roaming'),
			disabled: _('Roaming disabled'), unavailable: _('Roaming information unavailable'),
			stale: _('Roaming information expired'), mismatch: _('Wireless settings differ'),
			unsupported: _('Peer automatic roaming is unavailable'), error: _('Could not apply neighbor reports')
		};
		const reasons = {
			not_selected: _('Roaming disabled'), local_disabled: _('Local assistance is disabled'),
			local_unavailable: _('Local AP is unavailable'), local_ambiguous: _('Local SSID settings are ambiguous'),
			local_security_unknown: _('Local wireless security information is unavailable'),
			peer_unreachable: _('Peer is unreachable'), peer_forbidden: _('Peer denied snapshot access'),
			peer_unavailable: _('Peer snapshot is unavailable'), peer_stale: _('Peer snapshot expired'),
			identity_pending: _('Waiting for peer IP and MAC verification'), identity_mismatch: _('Peer IP and MAC do not match'),
			peer_upgrade_required: _('Upgrade the peer to use automatic SSID roaming'),
			peer_ssid_missing: _('The peer has not provided roaming information for this SSID'),
			peer_security_mismatch: _('Wireless security settings differ'),
			peer_reports_stale: _('Peer neighbor reports expired'), peer_reports_invalid: _('Peer neighbor reports are invalid'),
			peer_ambiguous: _('Peer SSID settings are ambiguous'), bssid_collision: _('Peer wireless identity conflicts'),
			awaiting_apply: _('Waiting for AP application'), apply_failed: _('Could not apply neighbor reports')
		};
		const networks = new Map();
		for (const peer of data?.peers || []) {
			const entries = Array.isArray(peer.roaming) ? peer.roaming :
				(peer.ssids || []).map(ssid => ({ ssid, state: 'pending' }));
			for (const entry of entries) {
				if (!networks.has(entry.ssid))
					networks.set(entry.ssid, new Map());
				networks.get(entry.ssid).set(peer.bridge_mac, { peer, entry });
			}
		}
		const groups = Array.from(networks, ([ssid, peers]) =>
			E('section', { class: 'wrtmesh-roaming-group', 'data-ssid': ssid }, [
				E('h4', {}, [ssid]),
				E('p', { class: 'wrtmesh-ssid-local' }, [
					E('strong', {}, [_('This device')]), ' · ', wrtmesh.ssidRadios(data?.local, ssid, data?.local_age)
				]),
				E('ul', { class: 'wrtmesh-roaming-networks' }, Array.from(peers.values(), ({ peer, entry }) => {
					const state = entry.state || 'pending';
					const label = state === 'active' ? states.active : reasons[entry.reason] || states[state] || states.pending;
					const age = Number.isFinite(entry.age) ? _('%d seconds ago').format(entry.age) : _('Update time unavailable');
					const expired = state === 'stale' || ['peer_stale', 'peer_reports_stale'].includes(entry.reason);
					const verified = peer.identity === 'verified' && !['identity_pending', 'identity_mismatch'].includes(entry.reason);
					const snapshot = peer.online && peer.status === 'fresh' && verified && entry.reason !== 'peer_reports_invalid' ? peer.data : null;
					return E('li', { class: 'wrtmesh-roaming-network', 'data-peer': peer.bridge_mac, 'data-ssid': ssid }, [
						E('strong', {}, [wrtmesh.nodeName(peer)]),
						E('span', { class: 'wrtmesh-roaming-state', 'data-state': state }, [label]),
						expired ? E('span', { class: 'wrtmesh-ssid-radios', 'data-state': 'stale' }, [_('Radio information expired')]) :
							wrtmesh.ssidRadios(snapshot, ssid, peer.age),
						E('span', { class: 'wrtmesh-secondary' }, [Number.isFinite(entry.age) ? _('Updated %s').format(age) : age])
					]);
				}))
			]));
		return section(_('SSID roaming assistance'), [
			...groups,
			!groups.length ? E('p', {}, [_('No SSIDs selected for roaming assistance.')]) : null
		]);
	},

	editor(peer, discovered) {
		const address = input('text', peer?.address, { maxlength: 15 });
		const mac = input('text', peer?.bridge_mac, { maxlength: 17, readonly: peer && !discovered ? '' : null });
		const name = input('text', peer?.name, { maxlength: 64 });
		const choices = [...new Set([...this.networks().map(network => network.ssid).filter(Boolean), ...(peer?.ssids || [])])];
		const selected = new Set(peer?.ssids || []);
		const ssids = choices.map(ssid => {
			const checkbox = input('checkbox', '', { checked: selected.has(ssid) ? '' : null,
				'aria-label': _('Allow roaming for %s').format(ssid) });
			const available = this.networks().some(network => network.ssid === ssid);
			return { ssid, checkbox, node: E('label', { class: 'wrtmesh-ssid-choice' }, [
				checkbox, E('span', {}, [ssid,
					!available ? E('small', { class: 'wrtmesh-secondary' }, [_('This SSID is no longer configured locally.')]) : null])
			]) };
		});
		ui.showModal(_('Mesh peer'), [
			discovered ? E('p', {}, _('Verify the peer IPv4 address and bridge MAC before saving. Discovery is unauthenticated.')) : null,
			field(_('Peer IPv4 address'), address),
			field(_('Bridge MAC address'), mac),
			field(_('Display name'), name),
			E('h4', {}, _('SSIDs allowed for roaming')),
			E('div', { class: 'wrtmesh-ssid-choices' }, ssids.length ? ssids.map(choice => choice.node) :
				E('p', {}, [_('No local AP SSIDs configured.') ])),
			E('p', { class: 'cbi-section-descr' }, _('BSSIDs and MLO links are learned automatically. The peer must offer the same SSID.')),
			E('p', { class: 'cbi-section-descr' }, _('Leave all SSIDs unchecked to exchange only station and topology information.')),
			E('div', { class: 'right' }, [
				E('button', { class: 'btn', click: ui.hideModal }, _('Cancel')),
				' ',
				E('button', { class: 'btn cbi-button-positive', click: this.action(async () => {
					const selected = ssids.filter(choice => choice.checkbox.checked).map(choice => choice.ssid);
					result(await savePeer(address.value.trim(), mac.value.trim(), name.value, selected));
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
					peer.ssids = known.ssids || [];
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
			E('p', {}, [_('Remove this peer from this device?'), ' ', wrtmesh.nodeName(peer)]),
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
				cell((p.ssids || []).join(', ') || '—')];
			if (this.writable)
				row.push(E('div', { class: 'wrtmesh-actions' }, [
					E('button', { class: 'btn', click: () => this.editor(p, false) }, _('Edit')), ' ',
					E('button', { class: 'btn cbi-button-negative', click: () => this.confirmRemove(p) }, _('Remove peer'))
				]));
			return row;
		});
		const headers = [_('Name'), _('IPv4 address'), _('Bridge MAC'), _('Peer status'), _('Roaming SSIDs')];
		if (this.writable)
			headers.push('');
		const truncated = data?.local?.truncated || data?.peers?.some(peer => peer.data?.truncated);
		return E('div', {}, [
			this.localNetworks(),
			section(_('Mesh peers'), [table(headers, peers, _('No peers configured.'))]),
			this.roamingStatus(data),
			section(_('Mesh topology'), [wrtmesh.topology(data)]),
			section(_('Associated Stations'), [
				truncated ? E('p', { class: 'cbi-section-descr' }, _('A node reached its station reporting limit.')) : null,
				E('p', { class: 'cbi-section-descr' },
					_('AP RX is from the client. AP TX is to the client. Rates are negotiated link rates.')),
				wrtmesh.stationTable(wrtmesh.stations(data, true), this.hostHints, { interfaces: true })
			])
		]);
	},

	render([data, writable, configuration, networkWritable]) {
		this.data = data;
		this.writable = writable;
		this.configuration = configuration?.data;
		this.configurationError = configuration?.error;
		this.networkWritable = networkWritable;
		this.content = E('div', {}, this.sections(data));
		poll.add(() => this.refresh().catch(error => this.notify(error)), 15);
		return E('div', { class: 'cbi-map' }, [
			wrtmesh.stylesheet(),
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
