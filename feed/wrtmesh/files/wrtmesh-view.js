'use strict';
'require view';
'require rpc';
'require poll';
'require ui';
'require wrtmesh';

const discover = rpc.declare({ object: 'wrtmesh', method: 'discover' });
const scan = rpc.declare({ object: 'wrtmesh', method: 'scan' });
const identify = rpc.declare({ object: 'wrtmesh', method: 'identify', params: ['address'] });
const savePeer = rpc.declare({
	object: 'wrtmesh', method: 'save', params: ['address', 'bridge_mac', 'name', 'profiles']
});
const removePeer = rpc.declare({ object: 'wrtmesh', method: 'remove', params: ['bridge_mac'] });
const getConfiguration = rpc.declare({ object: 'wrtmesh', method: 'configuration', raise: true });
const saveProfile = rpc.declare({
	object: 'wrtmesh', method: 'profile_save', params: ['id', 'section', 'enabled', 'interval', 'ttl'], raise: true
});
const removeProfile = rpc.declare({
	object: 'wrtmesh', method: 'profile_remove', params: ['id'], raise: true
});
const access = rpc.declare({
	object: 'session', method: 'access', params: ['scope', 'object', 'function'], expect: { access: false }
});

async function loadConfiguration() {
	const data = await L.resolveDefault(getConfiguration(), null);
	if (data && Array.isArray(data.profiles) && Array.isArray(data.ssids))
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
		invalid_bssid: _('Enter up to three distinct unicast BSSIDs for each roaming profile.'),
		duplicate_bssid: _('A BSSID is already used by this device or another peer on this profile.'),
		save_failed: _('Could not save the local Mesh settings.'),
		identity_unavailable: _('The peer did not return a valid Mesh identity. You can enter its details manually.'),
		lan_unavailable: _('The management LAN is unavailable.'),
		discovery_unavailable: _('The mDNS discovery service is unavailable.'),
		invalid_profile_id: _('Use a profile ID starting with a letter, followed by up to 47 letters, digits or underscores.'),
		profile_limit: _('This device already has 17 local roaming profiles.'),
		profile_not_found: _('This local roaming profile no longer exists. Refresh the page.'),
		invalid_profile_section: _('Select a local AP SSID.'),
		invalid_profile_enabled: _('Choose whether roaming assistance is enabled for this local SSID.'),
		profile_runtime_unavailable: _('The selected AP is unavailable. Save the profile disabled or bring the AP online.'),
		profile_runtime_ambiguous: _('The selected SSID has an ambiguous AP interface. Check its wireless configuration.'),
		profile_runtime_mismatch: _('The AP interface changed. Refresh the page and select the local SSID again.'),
		profile_metadata_unsupported: _('This AP interface is not supported for roaming assistance.'),
		invalid_profile_timers: _('Use a check interval from 30 to 300 seconds and an expiry from 180 to 1800 seconds, at least three times the interval.'),
		duplicate_profile_section: _('This local SSID is already selected by another roaming profile.'),
		config_busy: _('Another configuration edit is in progress. Apply or discard the pending wrtmesh changes before retrying.'),
		service_reload_failed: _('Settings were saved, but the roaming service could not reload. Check the service status.')
	};
	const error = new Error(errors[response.error] || _('Mesh request failed.'));
	error.saved = response.saved === true;
	throw error;
}

function input(type, value, attributes) {
	return E('input', { type, value: value || '', class: 'cbi-input-text', ...attributes });
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

	load() {
		return Promise.all([
			wrtmesh.loadStatus(),
			L.resolveDefault(access('ubus', 'wrtmesh', 'save'), false),
			loadConfiguration(),
			L.resolveDefault(access('ubus', 'wrtmesh', 'profile_save'), false)
		]);
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

	profileLabel(id) {
		const profile = this.configuration?.profiles?.find(profile => profile.id === id);
		return profile?.ssid ? '%s (%s)'.format(profile.ssid, id) : id;
	},

	profileEditor(profile) {
		const choices = this.configuration?.ssids || [];
		const limits = this.configuration?.limits || {};
		const id = input('text', profile?.id, {
			required: '', maxlength: 48, pattern: '[A-Za-z][A-Za-z0-9_]{0,47}',
			readonly: profile ? '' : null
		});
		const section = E('select', { class: 'cbi-input-select', required: '' }, [
			E('option', { value: '' }, [_('Select a local AP SSID')]),
			...choices.map(choice => E('option', { value: choice.section }, [
				choice.ssid || _('SSID unavailable'), ' (', choice.section, ')'
			])),
			profile?.section && !choices.some(choice => choice.section === profile.section)
				? E('option', { value: profile.section }, [_('SSID unavailable'), ' (', profile.section, ')']) : null
		]);
		section.value = profile?.section || '';
		const enabled = input('checkbox', '', { checked: profile?.enabled ? '' : null });
		const interval = input('number', profile?.interval ?? limits.interval?.default ?? 30, {
			required: '', min: limits.interval?.min ?? 30, max: limits.interval?.max ?? 300, step: 1
		});
		const ttl = input('number', profile?.ttl ?? limits.ttl?.default ?? 180, {
			required: '', min: limits.ttl?.min ?? 180, max: limits.ttl?.max ?? 1800, step: 1
		});
		const detected = E('p', { class: 'cbi-section-descr wrtmesh-profile-runtime' });
		const updateDetected = () => {
			const choice = choices.find(choice => choice.section === section.value);
			detected.textContent = !choice ? _('Select a local AP SSID') :
				choice.supported === false ? _('This AP interface is not supported for roaming assistance.') :
				!choice.available ? _('This AP is currently unavailable. Disabled profile settings can still be saved.') :
				choice.mlo ? _('Detected MLO with up to %d links.').format(choice.max_links) :
				_('Detected a single-link AP.');
		};
		section.addEventListener('change', updateDetected);
		updateDetected();
		ui.showModal(profile ? _('Edit local roaming profile') : _('Add local roaming profile'), [
			E('p', {}, _('A local profile selects an SSID on this AP. Use the same stable profile ID on the other APs for the same network.')),
			field(_('Stable profile ID'), id),
			field(_('Local AP SSID'), section),
			detected,
			field(_('Enable roaming assistance for this local SSID'), enabled),
			field(_('Check interval (seconds)'), interval),
			field(_('Neighbor report expiry (seconds)'), ttl),
			E('p', { class: 'cbi-section-descr' }, _('Expiry must be at least three times the check interval.')),
			E('div', { class: 'right wrtmesh-actions' }, [
				E('button', { class: 'btn', click: ui.hideModal }, _('Cancel')),
				E('button', { class: 'btn cbi-button-positive', click: this.action(async () => {
					for (const node of [id, section, interval, ttl])
						if (!node.reportValidity())
							return;
					if (Number(ttl.value) < 3 * Number(interval.value))
						throw new Error(_('Expiry must be at least three times the check interval.'));
					result(await saveProfile(id.value.trim(), section.value, enabled.checked, Number(interval.value), Number(ttl.value)));
					ui.hideModal();
					await this.refresh(true);
				}) }, _('Save local profile'))
			])
		]);
	},

	confirmRemoveProfile(profile) {
		ui.showModal(_('Remove local roaming profile'), [
			E('p', {}, [_('Remove this local roaming profile?'), ' ', this.profileLabel(profile.id)]),
			E('p', { class: 'cbi-section-descr' }, _('Existing remote BSSID approvals are retained for this profile ID.')),
			E('div', { class: 'right wrtmesh-actions' }, [
				E('button', { class: 'btn', click: ui.hideModal }, _('Cancel')),
				E('button', { class: 'btn cbi-button-negative', click: this.action(async () => {
					result(await removeProfile(profile.id));
					ui.hideModal();
					await this.refresh(true);
				}) }, _('Remove local profile'))
			])
		]);
	},

	localProfiles() {
		if (!this.configuration)
			return section(_('Local roaming profiles'), [
				E('p', { class: 'cbi-section-descr', 'data-state': this.configurationError },
					this.configurationError === 'forbidden' ? _('Permission to view local roaming settings was denied.') :
						_('Local roaming settings are unavailable.'))
			]);
		const rows = this.configuration.profiles.map(profile => {
			const row = [
				cell(profile.id),
				cell(profile.ssid || _('SSID unavailable')),
				cell(profile.enabled ? _('Roaming assistance enabled') : _('Roaming assistance disabled')),
				cell(profile.supported === false ? _('Radio information unavailable') :
					profile.mlo === true ? _('MLO, up to %d links').format(profile.max_links) :
					profile.mlo === false ? _('Single link') : _('Radio information unavailable')),
				cell('%d / %d s'.format(profile.interval, profile.ttl))
			];
			if (this.profileWritable)
				row.push(E('div', { class: 'wrtmesh-actions' }, [
					E('button', { class: 'btn', click: () => this.profileEditor(profile) }, _('Edit')),
					E('button', { class: 'btn', click: this.action(async () => {
						result(await saveProfile(profile.id, profile.section, !profile.enabled, profile.interval, profile.ttl));
						await this.refresh(true);
					}) }, profile.enabled ? _('Disable assistance') : _('Enable assistance')),
					E('button', { class: 'btn cbi-button-negative', click: () => this.confirmRemoveProfile(profile) }, _('Remove local profile'))
				]));
			return row;
		});
		const headers = [_('Profile ID'), _('Local SSID'), _('Assistance status'), _('Radio links'), _('Check / expiry')];
		if (this.profileWritable)
			headers.push('');
		return section(_('Local roaming profiles'), [
			E('p', { class: 'cbi-section-descr' }, _('Select the local SSIDs that publish and use roaming neighbor reports. Approve remote BSSIDs separately in each peer.')),
			this.profileWritable ? E('div', { class: 'wrtmesh-actions' }, [
				E('button', { class: 'btn cbi-button-add', click: () => this.profileEditor(null) }, _('Add local roaming profile'))
			]) : null,
			table(headers, rows, _('No local roaming profiles configured.'))
		]);
	},

	editor(peer, discovered) {
		const address = input('text', peer?.address, { maxlength: 15 });
		const mac = input('text', peer?.bridge_mac, { maxlength: 17, readonly: peer && !discovered ? '' : null });
		const name = input('text', peer?.name, { maxlength: 64 });
		const profileIds = this.configuration?.profiles?.map(profile => profile.id) || this.data?.profiles || [];
		const profiles = Object.fromEntries(profileIds.map(id => {
			const pins = peer?.profiles?.[id];
			return [id, input('text', Array.isArray(pins) ? pins.join(', ') : '', { maxlength: 60 })];
		}));
		ui.showModal(_('Mesh peer'), [
			discovered ? E('p', {}, _('Verify the bridge MAC and BSSIDs before saving this discovered peer. Discovery is unauthenticated.')) : null,
			field(_('Peer IPv4 address'), address),
			field(_('Bridge MAC address'), mac),
			field(_('Display name'), name),
			E('h4', {}, _('Remote BSSID approvals')),
			...Object.entries(profiles).map(([id, node]) => field(_('Remote BSSIDs for %s (optional)').format(this.profileLabel(id)), node)),
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
				cell(Object.keys(p.profiles).map(id => this.profileLabel(id)).join(', ') || '—')];
			if (this.writable)
				row.push(E('div', { class: 'wrtmesh-actions' }, [
					E('button', { class: 'btn', click: () => this.editor(p, false) }, _('Edit')), ' ',
					E('button', { class: 'btn cbi-button-negative', click: () => this.confirmRemove(p) }, _('Remove peer'))
				]));
			return row;
		});
		const headers = [_('Name'), _('IPv4 address'), _('Bridge MAC'), _('Peer status'), _('BSSID approval profiles')];
		if (this.writable)
			headers.push('');
		const stationRows = wrtmesh.stations(data, true).map(s => [
			wrtmesh.stationNetwork(s), cell(s.mac.toUpperCase()), wrtmesh.stationHost(s),
			wrtmesh.stationSignal(s.signal), wrtmesh.stationRates(s)
		]);
		const truncated = data?.local?.truncated || data?.peers?.some(peer => peer.data?.truncated);
		return E('div', {}, [
			this.localProfiles(),
			section(_('Mesh peers'), [table(headers, peers, _('No peers configured.'))]),
			section(_('Mesh topology'), [wrtmesh.topology(data)]),
			section(_('Associated Stations'), [
				truncated ? E('p', { class: 'cbi-section-descr' }, _('A node reached its station reporting limit.')) : null,
				table([_('Network'), _('MAC address'), _('Host'), _('Signal'),
					'%s / %s'.format(_('RX Rate'), _('TX Rate'))], stationRows, _('No associated stations reported.'))
			])
		]);
	},

	render([data, writable, configuration, profileWritable]) {
		this.data = data;
		this.writable = writable;
		this.configuration = configuration?.data;
		this.configurationError = configuration?.error;
		this.profileWritable = profileWritable;
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
