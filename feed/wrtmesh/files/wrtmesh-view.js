'use strict';
'require view';
'require rpc';
'require poll';
'require ui';
'require wrtmesh';
'require network';
'require uci';

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
const getReadiness = rpc.declare({ object: 'wrtmesh', method: 'readiness', reject: true });
const getPendingChanges = rpc.declare({ object: 'uci', method: 'changes', reject: true });
const wirelessAccess = rpc.declare({
	object: 'session', method: 'access', params: ['scope', 'object', 'function'], reject: true
});

async function loadReadiness() {
	try {
		const data = await getReadiness();
		if (data?.version === 1 && !data.error && Array.isArray(data.aps))
			return { data };
	} catch (e) { /* Older or restricted installations keep the rest of Mesh. */ }
	return { error: 'unavailable' };
}

async function canConfigureWireless() {
	try {
		const permissions = await Promise.all(['read', 'write'].map(mode => wirelessAccess('uci', 'wireless', mode)));
		return permissions.some(value => value?.access === false) ? false :
			permissions.every(value => value?.access === true) ? true : null;
	} catch (e) {
		return null;
	}
}

function canStageWireless() {
	return typeof uci.callSet === 'function' && typeof ui.changes?.displayChanges === 'function' &&
		typeof ui.changes?.renderChangeIndicator === 'function';
}

function pendingChanges(response) {
	if (!response || typeof response.changes !== 'object' || response.changes === null || Array.isArray(response.changes))
		throw new Error(_('Could not check pending changes. Use the wireless settings page.'));
	if (Object.values(response.changes).some(records => !Array.isArray(records)))
		throw new Error(_('Could not check pending changes. Use the wireless settings page.'));
	return response.changes;
}

function localWirelessEdits() {
	return ['creates', 'changes', 'deletes', 'reorder'].some(kind => {
		const value = uci.state?.[kind]?.wireless;
		return value && (typeof value !== 'object' || Object.keys(value).length > 0);
	});
}

const configured = value => value === true ? _('Enabled') : value === false ? _('Disabled') : _('Default');
const active = value => value === 'enabled' ? _('Enabled') : value === 'disabled' ? _('Disabled') : _('Cannot confirm');
const capability = value => value === 'supported' ? _('Available') : value === 'unsupported' ? _('Unsupported') : _('Cannot confirm');
const interfacesOf = ap => Array.isArray(ap.interfaces) ? ap.interfaces : [];
const allNR = (ap, field, value) => interfacesOf(ap).length > 0 && interfacesOf(ap).every(iface => iface[field]?.nr_api === value);

function readinessState(ap, worker) {
	const interfaces = interfacesOf(ap);
	if (interfaces.some(iface => iface.capabilities?.nr_api === 'unsupported'))
		return { state: 'unsupported', text: _('Unsupported'), reason: _('Neighbor report API unavailable') };
	if (ap.disabled || interfaces.some(iface => iface.status === 'disabled'))
		return { state: 'off', text: _('Not enabled'), reason: _('AP unavailable') };
	if (worker?.enabled === false)
		return { state: 'off', text: _('Not enabled'), reason: _('wrtmesh worker is disabled') };
	if (worker?.enabled === true && worker.supported !== true)
		return { state: 'unknown', text: _('Cannot confirm'), reason: _('wrtmesh worker readiness is not confirmed') };
	if (interfaces.some(iface => iface.runtime?.nr?.state === 'disabled'))
		return { state: 'off', text: _('Not enabled'), reason: _('Neighbor reports are not active') };
	if (worker?.enabled && worker.supported === true && allNR(ap, 'capabilities', 'supported') &&
		interfaces.every(iface => iface.runtime?.nr?.state === 'enabled'))
		return { state: 'ready', text: _('Ready') };
	return { state: 'unknown', text: _('Cannot confirm'), reason: _('Current neighbor report operation is not confirmed') };
}

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
			L.resolveDefault(access('ubus', 'wrtmesh', 'network_save'), false),
			loadReadiness(), canConfigureWireless()
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
				this.notify(error);
				try { await this.refresh(true); } catch (refreshError) { this.notify(refreshError); }
			} else {
				this.notify(error);
			}
		}));
	},

	async refresh(force) {
		const data = await wrtmesh.loadStatus(force);
		if (force) {
			const configuration = await loadConfiguration();
			this.configuration = configuration.data;
			this.configurationError = configuration.error;
			const readiness = await loadReadiness();
			this.readiness = readiness.data;
			this.readinessChecked = Date.now();
			this.wirelessWritable = await canConfigureWireless();
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
			E('p', { class: 'cbi-section-descr' }, _('This controls wrtmesh collection and neighbor synchronization, not wireless k/v/r options.')),
			field(_('Enable the wrtmesh worker for this SSID'), enabled),
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

	async recheckReadiness() {
		const readiness = await loadReadiness();
		this.readiness = readiness.data;
		this.readinessChecked = Date.now();
		this.wirelessWritable = await canConfigureWireless();
		const tracked = new Set([...(this.pendingNeighbors || []), ...(this.uncertainNeighbors || [])]);
		if (tracked.size) {
			this.pendingNeighbors ||= new Set();
			this.uncertainNeighbors ||= new Set();
			try {
				const changes = pendingChanges(await getPendingChanges());
				for (const sid of tracked) {
					if (changes.wireless?.some(record => record[0] === 'set' && record[1] === sid && record[2] === 'rrm_neighbor_report' && record[3] === '1'))
						this.pendingNeighbors.add(sid);
					else
						this.pendingNeighbors.delete(sid);
					this.uncertainNeighbors.delete(sid);
				}
			} catch (e) {
				for (const sid of tracked) {
					this.pendingNeighbors.delete(sid);
					this.uncertainNeighbors.add(sid);
				}
			}
		}
		this.content.replaceChildren(this.sections(this.data));
	},

	workerFor(ap) {
		if (typeof ap.section !== 'string' || !ap.section) return null;
		const group = this.networks().find(network => network.section === ap.section ||
			network.sections?.includes(ap.section) || network.members?.some(member => member.section === ap.section));
		if (!group) return null;
		const member = group.members?.find(item => item.section === ap.section);
		const profiles = group.profiles?.filter(profile => profile.section === ap.section);
		return { ...group, editor: group,
			enabled: profiles ? profiles.length > 0 && profiles.every(profile => profile.enabled) :
				group.members?.length > 1 ? undefined : group.enabled,
			supported: group.reason === 'local_ambiguous' ? false : !profiles?.length ? undefined :
				(member?.supported ?? group.supported) === true && profiles.every(profile => profile.supported === true)
		};
	},

	optionalCapabilities(ap) {
		const interfaces = interfacesOf(ap);
		const option = (label, configValue, field, method) => E('li', {}, [
			E('strong', {}, [label]),
			E('span', { class: 'wrtmesh-secondary' }, [_('Configured: %s').format(configured(configValue))]),
			...interfaces.map(iface => E('span', { class: 'wrtmesh-secondary' }, [
				iface.iface, ' · ', _('Active: %s').format(active(iface.runtime?.[field]?.state)),
				method ? ' · ' + _('API: %s').format(capability(iface.capabilities?.[method])) : ''
			]))
		]);
		return E('details', { class: 'wrtmesh-network-advanced' }, [
			E('summary', {}, [_('Optional capabilities')]),
			E('ul', { class: 'wrtmesh-readiness-options' }, [
				option(_('Beacon measurement (optional)'), ap.configuration?.rrm_beacon_report, 'beacon', 'beacon_api'),
				option(_('BSS Transition (optional)'), ap.configuration?.bss_transition, 'btm', 'btm_api'),
				option(_('Fast Transition (optional)'), ap.configuration?.ieee80211r, 'ft')
			]),
			E('p', { class: 'cbi-section-descr' }, _('wrtmesh does not send BTM steering requests. Configure FT and its mobility domain in wireless settings.')),
			E('a', { href: L.url('admin/network/wireless') }, [_('Wireless settings')])
		]);
	},

	async neighborReportEditor(ap) {
		const title = [ap.ssid, ...interfacesOf(ap).map(iface => iface.iface)].filter(Boolean).join(' · ');
		const save = async () => {
			const permission = await canConfigureWireless();
			if (permission === false)
				throw new Error(_('Permission to change wireless settings was denied.'));
			if (permission !== true || !canStageWireless())
				throw new Error(_('Wireless configuration access could not be confirmed. Use wireless settings.'));
			const changes = pendingChanges(await getPendingChanges());
			if (changes.wireless?.length || localWirelessEdits())
				throw new Error(_('Apply or discard existing wireless changes first.'));
			const latest = (await loadReadiness()).data?.aps.find(item => item.section === ap.section);
			if (!latest || latest.ssid !== ap.ssid || JSON.stringify(latest.devices) !== JSON.stringify(ap.devices) ||
				latest.ownership === 'readonly' || !allNR(latest, 'capabilities', 'supported'))
				throw new Error(_('The AP settings changed or support could not be confirmed. Recheck before saving.'));
			if (latest.configuration?.rrm_neighbor_report !== ap.configuration?.rrm_neighbor_report || latest.configuration?.nr === true)
				throw new Error(_('The AP settings changed or support could not be confirmed. Recheck before saving.'));
			const finalChanges = pendingChanges(await getPendingChanges());
			if (finalChanges.wireless?.length || localWirelessEdits())
				throw new Error(_('Apply or discard existing wireless changes first.'));
			// Standard UCI staging only: never commit, apply or flush other local edits.
			let saved;
			try {
				await uci.callSet('wireless', ap.section, { rrm_neighbor_report: '1' });
				saved = pendingChanges(await getPendingChanges());
				if (!saved.wireless?.some(record => record[0] === 'set' && record[1] === ap.section && record[2] === 'rrm_neighbor_report' && record[3] === '1'))
					throw new Error('pending result unavailable');
			} catch (e) {
				this.uncertainNeighbors ||= new Set();
				this.uncertainNeighbors.add(ap.section);
				this.pendingNeighbors?.delete(ap.section);
				const error = new Error(_('The setting may be staged, but its pending state could not be confirmed. Review wireless settings.'));
				error.saved = true;
				throw error;
			}
			this.pendingNeighbors ||= new Set();
			this.pendingNeighbors.add(ap.section);
			this.uncertainNeighbors?.delete(ap.section);
			ui.changes.renderChangeIndicator(saved);
			ui.showModal(_('Neighbor report saved'), [
				E('p', {}, [title]),
				E('p', {}, _('Saved as pending. Wireless has not been reloaded. Applying may briefly disconnect clients.')),
				E('p', { class: 'cbi-section-descr' }, _('The standard changes dialog includes all pending changes in this session.')),
				E('div', { class: 'right wrtmesh-actions' }, [
					E('button', { class: 'btn', click: ui.hideModal }, [_('Close')]),
					E('button', { class: 'btn cbi-button-positive', click: () => ui.changes.displayChanges() }, [_('Review pending changes')])
				])
			]);
			this.content.replaceChildren(this.sections(this.data));
		};
		ui.showModal(_('Enable neighbor reports'), [
			E('p', {}, [title]),
			E('p', { class: 'wrtmesh-config-preview' }, ['wireless.', ap.section, '.rrm_neighbor_report: ',
				configured(ap.configuration?.rrm_neighbor_report), ' → 1']),
			E('p', {}, _('Only neighbor reporting for this AP will be saved. Beacon, BTM, FT and other wireless settings stay as configured.')),
			E('p', { class: 'cbi-section-descr' }, _('Save creates a pending change. Apply it separately in the standard LuCI changes dialog; applying may briefly disconnect clients.')),
			E('p', { class: 'cbi-section-descr' }, _('If wireless is managed declaratively, adjust its configuration source.')),
			E('div', { class: 'right wrtmesh-actions' }, [
				E('button', { class: 'btn', click: ui.hideModal }, [_('Cancel')]),
				E('button', { class: 'btn cbi-button-positive', click: this.action(save) }, [_('Save pending change')])
			])
		]);
	},

	localNetworks() {
		const aps = this.readiness?.aps || this.networks().flatMap(network => network.members?.length ? network.members : [network]);
		const cards = aps.map(ap => {
			const worker = this.workerFor(ap);
			const status = readinessState(ap, worker);
			const pending = this.pendingNeighbors?.has(ap.section);
			const uncertain = this.uncertainNeighbors?.has(ap.section);
			const interfaces = interfacesOf(ap);
			const canEnable = typeof ap.section === 'string' && ap.mode === 'ap' && typeof ap.ssid === 'string' && ap.ssid.length > 0 &&
				this.wirelessWritable === true && canStageWireless() && ap.ownership !== 'readonly' &&
				allNR(ap, 'capabilities', 'supported') && ap.configuration?.nr !== true && !pending && !uncertain;
			return E('li', { class: 'wrtmesh-roaming-network wrtmesh-local-network', 'data-section': ap.section }, [
				E('strong', {}, [ap.ssid || _('SSID unavailable')]),
				E('span', { class: 'wrtmesh-secondary' }, [interfaces.map(iface => iface.iface).join(' / ') || ap.iface || _('Interface unknown')]),
				E('span', { class: 'wrtmesh-readiness-state', 'data-state': uncertain ? 'unknown' : pending ? 'pending' : status.state }, [uncertain ? _('Pending save could not be confirmed') : pending ? _('Saved, awaiting apply') : status.text]),
				!pending && !uncertain && status.reason ? E('span', { class: 'wrtmesh-secondary' }, [status.reason]) : null,
				E('span', {}, [_('wrtmesh worker: %s').format(typeof worker?.enabled === 'boolean' ? configured(worker.enabled) : _('Cannot confirm'))]),
				E('span', { class: 'wrtmesh-secondary' }, [_('Neighbor reports (required)'), ' · ',
					_('Configured: %s').format(configured(ap.configuration?.rrm_neighbor_report)), ' · ',
					_('API: %s').format(capability(interfaces.length && interfaces.every(iface => iface.capabilities?.nr_api === 'supported') ? 'supported' :
						interfaces.some(iface => iface.capabilities?.nr_api === 'unsupported') ? 'unsupported' : 'unknown')), ' · ',
					_('Active: %s').format(active(interfaces.length && interfaces.every(iface => iface.runtime?.nr?.state === 'enabled') ? 'enabled' :
						interfaces.some(iface => iface.runtime?.nr?.state === 'disabled') ? 'disabled' : 'unknown'))]),
				interfaces.some(iface => iface.runtime?.nr?.source === 'cached_neighbor_report') ?
					E('span', { class: 'wrtmesh-secondary' }, [_('Confirmed by recent local collection')]) : null,
				ap.ownership === 'readonly' ? E('span', { class: 'wrtmesh-secondary' }, [_('Wireless configuration is read-only; adjust its source.')]) : null,
				E('div', { class: 'wrtmesh-actions' }, [
					worker && this.networkWritable ? E('button', { class: 'btn', click: () => this.networkEditor(worker.editor || worker) }, [_('Worker settings')]) : null,
					canEnable ? E('button', { class: 'btn cbi-button-action', click: this.action(() => this.neighborReportEditor(ap)) }, [_('Enable neighbor reports')]) : null
				]),
				this.optionalCapabilities(ap)
			]);
		});
		return section(_('Local wireless networks'), [
			E('p', { class: 'cbi-section-descr' }, _('The worker switch controls wrtmesh only. Neighbor reports are required for assistance; Beacon, BTM and FT are optional.')),
			E('div', { class: 'wrtmesh-actions' }, [
				E('button', { class: 'btn', click: this.action(() => this.recheckReadiness()) }, [_('Recheck readiness')]),
				E('a', { class: 'btn', href: L.url('admin/network/wireless') }, [_('Wireless settings')])
			]),
			this.readinessChecked ? E('p', { class: 'cbi-section-descr' }, [_('Checked at %s').format(new Date(this.readinessChecked).toLocaleTimeString())]) : null,
			!this.readiness ? E('p', { class: 'cbi-section-descr' }, [_('Readiness information is unavailable; existing Mesh features remain available.')]) : null,
			this.wirelessWritable === false ? E('p', { class: 'cbi-section-descr' }, [_('Wireless settings are read-only in this session.')]) :
				this.wirelessWritable !== true || !canStageWireless() ? E('p', { class: 'cbi-section-descr' }, [_('Wireless configuration access could not be confirmed. Use wireless settings.')]) : null,
			cards.length ? E('ul', { class: 'wrtmesh-roaming-networks wrtmesh-local-networks' }, cards) :
				E('p', { 'data-state': !this.configuration && !this.readiness ? this.configurationError || 'unavailable' : null },
					[!this.configuration && !this.readiness ? this.configurationError === 'forbidden' ? _('Permission to view local roaming settings was denied.') :
						_('Local roaming settings are unavailable.') : _('No local AP SSIDs configured.')])
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

	render([data, writable, configuration, networkWritable, readiness, wirelessWritable]) {
		this.data = data;
		this.writable = writable;
		this.configuration = configuration?.data;
		this.configurationError = configuration?.error;
		this.networkWritable = networkWritable;
		this.readiness = readiness?.data;
		this.readinessChecked = Date.now();
		this.wirelessWritable = wirelessWritable === true ? true : wirelessWritable === false ? false : null;
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
