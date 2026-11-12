/* Exercise the actual LuCI Overview loader and wrtmesh views in Chromium.
 * Only the browser shell, system data and RPC transport are fixtures. */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.WRTMESH_PLAYWRIGHT || 'playwright');

const luci = process.argv[2];
const installed = process.argv[3];
if (!luci)
	throw new Error('Usage: node tests/test-luci-browser.cjs LUCI_FEED [INSTALLED_ROOT]');

const repo = path.resolve(__dirname, '..');
const status = 'modules/luci-mod-status/htdocs/luci-static/resources/view/status';
const source = (name, location = name) => fs.readFileSync(installed
	? path.join(installed, 'www/luci-static/resources', location)
	: path.join(repo, 'feed/wrtmesh/files', name), 'utf8');
const scripts = {
	overview: fs.readFileSync(path.join(luci, status, 'index.js'), 'utf8'),
	wifi: fs.readFileSync(path.join(luci, status, 'include/60_wifi.js'), 'utf8'),
	include: source('65_wrtmesh.js', 'view/status/include/65_wrtmesh.js'),
	mesh: source('wrtmesh.js'),
	management: source('wrtmesh-view.js', 'view/network/wrtmesh.js')
};
assert(!scripts.wifi.includes('wrtmesh'), 'provide the unpatched LuCI source');
if (process.env.WRTMESH_LEGACY_WIFI)
	scripts.legacyWifi = fs.readFileSync(process.env.WRTMESH_LEGACY_WIFI, 'utf8');

const station = (n, values) => ({
	mac: '02:00:00:00:02:' + n, iface: 'ap-mld0', ssid: 'Example', signal: -55,
	rx: 17200000, tx: 96070000, ...values
});
const mld = '02:00:00:00:03:10';
const mobileClient = station('10', {
	mld, ipv4: '192.168.50.42',
	links: [
		{ id: 0, mac: '02:00:00:00:02:11', bssid: '02:00:00:00:04:11', freq: 5180, channel: 36, signal: -55,
			rx: 17200000, tx: 96070000 },
		{ id: 1, mac: '02:00:00:00:02:12', bssid: '02:00:00:00:04:12', freq: 6115, channel: 33 }
	]
});
const gateway = { address: '192.168.50.1', bridge: 'br-lan', port: 'wan', medium: 'ethernet' };
const local = { name: 'Local AP', bridge_mac: '02:00:00:00:00:02', gateway, stations: [station('20')] };
const peer = (n, name, status, stations, age = 0) => ({
	bridge_mac: '02:00:00:00:00:' + n, address: '192.168.50.' + n, name, status,
	online: status === 'fresh', age, updated_at: age == null ? null : 1762900000 - age, profiles: {}, ssids: [],
	data: status === 'fresh' ? { name, gateway, stations } : null
});
const mesh = peers => ({ address: '192.168.50.2', local, local_age: 0, peers, profiles: [] });
const configuration = {
	profiles: [],
	ssids: [
		{ section: 'ssid_main', ssid: 'Local Wi-Fi', iface: 'ap-mld0', mlo: true,
			max_links: 3, available: true, supported: true },
		{ section: 'ssid_iot', ssid: 'Local IoT', iface: 'ap-iot', mlo: false,
			max_links: 1, available: true, supported: true }
	],
	networks: [
		{ section: 'ssid_main', ssid: 'Local Wi-Fi', iface: 'ap-mld0', mlo: true, max_links: 3, available: true, supported: true, enabled: false, interval: 30, ttl: 180 },
		{ section: 'ssid_iot', ssid: 'Local IoT', iface: 'ap-iot', mlo: false, max_links: 1, available: true, supported: true, enabled: false, interval: 30, ttl: 180 }
	],
	limits: { profiles: 17, interval: { min: 30, max: 300, default: 30 },
		ttl: { min: 180, max: 1800, default: 180 } }
};
const peers = [
	peer('11', 'Office', 'fresh', [mobileClient, station('21')], 2),
	peer('12', 'Upstairs', 'fresh', [station('12', { mld })], 30),
	peer('13', 'Kitchen', 'fresh', []),
	peer('14', 'Stale AP', 'stale', [], 96),
	peer('15', 'Offline AP', 'unreachable', [], null),
	peer('16', 'Denied AP', 'forbidden', [], null),
	peer('17', 'Busy AP', 'unavailable', [], null),
	peer('18', 'New AP', 'unknown', [], null)
];

async function harness(browser, { installed = true, data, writable = false, readable = true, mobile = false,
	legacyWifi = false, config = configuration, configReadable = true }) {
	const page = await browser.newPage({ viewport: { width: mobile ? 390 : 1300, height: 940 } });
	const errors = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.route('**/*', route => {
		const url = new URL(route.request().url());
		if (url.hostname !== 'wrtmesh.test')
			return route.abort();
		if (url.pathname === '/')
			return route.fulfill({ contentType: 'text/html', body: '<main></main>' });
		if (url.pathname.endsWith('/wrtmesh.css'))
			return route.fulfill({ contentType: 'text/css', body: source('wrtmesh.css') });
		return route.fulfill({ status: 404, body: '' });
	});
	await page.goto('http://wrtmesh.test/');
	await page.evaluate(async ({ scripts, installed, data, writable, readable, legacyWifi, config, configReadable }) => {
		window._ = text => text;
		String.prototype.format = function (...values) {
			return this.replace(/%([sdh]|\.(\d+)f)/g, (_, kind, decimals) => {
				const value = values.shift();
				if (decimals != null)
					return Number(value).toFixed(Number(decimals));
				if (kind === 'd')
					return String(Math.trunc(value));
				return String(value);
			});
		};
		window.E = (tag, attrs, children) => {
			const node = Array.isArray(tag) ? document.createDocumentFragment() : document.createElement(tag);
			if (Array.isArray(tag))
				children = tag;
			else if (attrs instanceof Node || typeof attrs === 'string' || Array.isArray(attrs))
				[attrs, children] = [null, attrs];
			for (const [key, value] of Object.entries(attrs || {})) {
				if (typeof value === 'function')
					node.addEventListener(key, value);
				else if (value != null)
					node.setAttribute(key, value);
			}
			const append = child => {
				if (Array.isArray(child))
					child.forEach(append);
				else if (child != null)
					node.append(child instanceof Node ? child : String(child));
			};
			append(children);
			return node;
		};
		window.cbi_update_table = (table, rows, placeholder) => {
			for (const row of rows)
				table.append(E('tr', {}, row.map(cell => E('td', {}, cell))));
			if (!rows.length && placeholder)
				table.append(E('tr', {}, E('td', {}, placeholder)));
		};
		window.baseclass = window.view = { extend: implementation => implementation };
		window.dom = { content: (node, content) => node.replaceChildren(content) };
		window.ui = { createHandlerFn: (ctx, fn, ...args) =>
			(typeof fn === 'string' ? ctx[fn] : fn).bind(ctx, ...args),
			showModal: (title, contents) => {
				const dialog = E('section', { role: 'dialog', 'aria-label': title }, [
					E('h2', {}, title), ...contents
				]);
				document.querySelector('[role="dialog"]')?.remove();
				document.body.append(dialog);
				return dialog;
			},
			hideModal: () => document.querySelector('[role="dialog"]')?.remove(),
			addNotification: (_, content) => document.body.append(E('div', { role: 'alert' }, content))
		};
		window.uci = { get: () => null, load: async () => ({}) };
		window.firewall = { getZones: async () => [] };
		window.poll = { add: fn => { window.pollOverview = fn; } };
		window.mock = { data, configuration: config, calls: 0, configCalls: 0, operations: [], now: Date.now() };
		Date.now = () => window.mock.now;
		window.rpc = { declare: ({ object, method, expect }) => async (...args) => {
			if (object === 'wrtmesh' && method === 'status') {
				window.mock.calls++;
				if (window.mock.data === null)
					throw new Error('RPC unavailable');
				return window.mock.data;
			}
			if (object === 'wrtmesh' && method === 'configuration') {
				window.mock.configCalls++;
				return window.mock.configuration;
			}
			if (object === 'wrtmesh' && method === 'network_save') {
				window.mock.operations.push({ method, args });
				const [section, enabled, interval, ttl] = args;
				const value = window.mock.configuration.networks.find(choice => choice.section === section);
				Object.assign(value, { enabled, interval, ttl });
				return window.mock.networkReloadFail ? { saved: true, error: 'service_reload_failed' } : { saved: true };
			}
			if (object === 'wrtmesh' && method === 'peer_save') {
				window.mock.operations.push({ method, args });
				const [address, bridge_mac, name, ssids] = args;
				const peer = window.mock.data.peers.find(peer => peer.bridge_mac === bridge_mac);
				Object.assign(peer, { address, name, ssids });
				peer.roaming = ssids.map(ssid => ({ ssid, state: 'pending', age: 0,
					local_applied: false }));
				for (const network of window.mock.configuration.networks)
					if (ssids.includes(network.ssid))
						network.enabled = true;
				return window.mock.networkReloadFail ? { saved: true, error: 'service_reload_failed' } : { saved: true };
			}
			if (object === 'session' && method === 'access') {
				const access = args.includes('peer_save') || args.includes('network_save') ? writable :
					args.includes('status') ? readable : args.includes('configuration') ? configReadable : true;
				return expect?.access !== undefined ? access : { access };
			}
			throw new Error('Unexpected RPC ' + object + '.' + method);
		} };
		const hosts = {
			getHostnameByMACAddr: mac => mac.toLowerCase().endsWith(':10') ? 'Example client' : null,
			getIPAddrByMACAddr: mac => mac.toLowerCase().endsWith(':33') ? '192.168.68.153' : null,
			getIP6AddrByMACAddr: mac => mac.toLowerCase().endsWith(':34') ? 'fd00::34' : null
		};
		const radio = { getName: () => 'radio0', getI18n: () => 'Test radio', isUp: () => true };
		const net = {
			sid: 'default_radio0', getAssocList: async () => [{
				mac: '02:00:00:00:02:20', signal: -46, noise: -96, rx: { rate: 520000, mhz: 80 },
				tx: { rate: 480000, mhz: 80 }
			}],
			getBSSID: () => '02:00:00:00:01:01', getChannel: () => 36, isDisabled: () => false,
			getSignalPercent: () => 80, getSignal: () => -46, getActiveSSID: () => 'Local Wi-Fi',
			getActiveMode: () => 'Master', getActiveBSSID: () => '02:00:00:00:01:01',
			getActiveEncryption: () => 'WPA2', getCountryCode: () => 'US', getFrequency: () => 5.18,
			getBitRate: () => 600, getNoise: () => -96, getTXPower: () => 20,
			getWifiDeviceName: () => 'radio0', getI18n: () => 'Local Wi-Fi', getIfname: () => 'ap0',
			getShortName: () => 'Local Wi-Fi', isClientDisconnectSupported: () => false
		};
		window.network = {
			flushCache: async () => {}, getHostHints: async () => hosts,
			getWifiDevices: async () => [radio], getWifiNetworks: async () => [net]
		};
		window.fs = { list: async () => ['60_wifi.js', ...(installed ? ['65_wrtmesh.js'] : [])]
			.map(name => ({ name, type: 'file' })) };
		const modules = {};
		window.L = {
			bind: (fn, self, ...args) => fn.bind(self, ...args),
			resource: resource => '/luci-static/resources/' + resource,
			require: async name => {
				if (!Object.hasOwn(modules, name))
					throw new Error('Unexpected module ' + name);
				return modules[name];
			},
			resolveDefault: (promise, fallback) => Promise.resolve(promise).catch(() => fallback),
			hasSystemFeature: () => false, toArray: value => value == null ? [] : [value],
			itemlist: (node, items) => {
				for (let i = 0; i < items.length; i += 2)
					if (items[i + 1] != null)
						node.append(E('span', {}, [items[i], ' ', items[i + 1]]));
				return node;
			}
		};
		window.renderBadge = (icon, label, ...items) => L.itemlist(E('span'), items);
		window.wrtmesh = modules.wrtmesh = new Function(scripts.mesh)();
		modules['view.status.include.60_wifi'] = new Function(legacyWifi ? scripts.legacyWifi : scripts.wifi)();
		if (installed)
			modules['view.status.include.65_wrtmesh'] = new Function(scripts.include)();
		const overview = new Function(scripts.overview)();
		document.querySelector('main').append(await overview.render(await overview.load()));
		window.renderManagement = async () => {
			const management = new Function(scripts.management)();
			document.querySelector('main').replaceChildren(management.render(await management.load()));
		};
	}, { scripts, installed, data, writable, readable, legacyWifi, config, configReadable });
	return { page, errors };
}

(async () => {
	const browser = await chromium.launch({
		executablePath: process.env.WRTMESH_CHROMIUM,
		args: ['--no-sandbox', '--disable-dev-shm-usage']
	});
	try {
		for (const installed of [false, true]) {
			const { page, errors } = await harness(browser, { installed, data: mesh([]) });
			assert.equal(await page.locator('#wifi_assoclist_table').getByText('02:00:00:00:02:20').count(), 1);
			assert.equal(await page.locator('.wrtmesh-overview').count(), installed ? 1 : 0);
			assert.equal(await page.locator('.wrtmesh-client-group').count(), 0);
			assert.equal(await page.evaluate(() => mock.calls), installed ? 1 : 0);
			assert.deepEqual(errors, []);
			await page.close();
		}
		const { page, errors } = await harness(browser, { data: mesh(peers), mobile: true });
		assert.equal(await page.locator('.wrtmesh-client-group').count(), peers.length);
		for (const state of ['fresh', 'empty', 'stale', 'unreachable', 'forbidden', 'unavailable', 'unknown', 'overlap'])
			assert(await page.locator('.wrtmesh-client-state[data-state="' + state + '"]').count(), state);
		assert.equal(await page.locator('.wrtmesh-client-table [data-client]').count(), 2);
		assert.equal(await page.locator('.wrtmesh-client-state[data-state="stale"] time').count(), 1);
		assert.equal(await page.locator('.wrtmesh-client-mobile-label').first().isVisible(), true);
		const detail = page.locator('details.wrtmesh-client-details').filter({ hasText: '192.168.50.42' });
		assert.equal(await detail.count(), 1);
		assert.equal(await detail.locator('summary').isVisible(), true);
		await detail.locator('summary').click();
		assert.equal(await detail.evaluate(node => node.open), true);
		assert.match(await page.locator('.wrtmesh-overview').textContent(), /172\.0.*960\.7/s);
		assert.match(await page.locator('.wrtmesh-overview').textContent(), /5\s*GHz.*6\s*GHz/s);
		await page.evaluate(() => pollOverview());
		assert.equal(await page.evaluate(() => mock.calls), 1, 'Overview uses the common RPC cache');
		assert.equal(await detail.evaluate(node => node.open), true, 'polling preserves expanded client details');
		await page.evaluate(() => { mock.now += 16000; return pollOverview(); });
		assert.equal(await page.evaluate(() => mock.calls), 2, 'Overview reloads after the cache window');
		await page.evaluate(() => renderManagement());
		assert.equal(await page.evaluate(() => mock.calls), 2, 'Mesh view reuses cached data');
		assert.equal(await page.getByRole('img', { name: 'Mesh topology' }).count(), 1);
		assert.equal(await page.getByRole('heading', { name: 'Associated Stations' }).count(), 1);
		assert.equal(await page.getByRole('heading', { name: 'Local wireless networks', exact: true }).count(), 1);
		assert.equal(await page.getByRole('button', { name: 'Add local roaming profile', exact: true }).count(), 0);
		await page.evaluate(() => pollOverview());
		assert.equal(await page.evaluate(() => mock.configCalls), 1, 'routine polling does not repeat wireless configuration discovery');
		assert.deepEqual(errors, []);
		await page.close();

		for (const readable of [false, true]) {
			const { page, errors } = await harness(browser, { data: null, readable });
			const state = readable ? 'unavailable' : 'forbidden';
			assert(await page.locator('.wrtmesh-client-state[data-state="' + state + '"]').count(), state);
			assert.equal(await page.locator('#wifi_assoclist_table').count(), 1);
			assert.deepEqual(errors, []);
			await page.close();
		}
		for (const configReadable of [false, true]) {
			const { page, errors } = await harness(browser, { data: mesh([]), config: null, configReadable });
			await page.evaluate(() => renderManagement());
			const profiles = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Local wireless networks', exact: true }) });
			assert.equal(await profiles.locator('[data-state="' + (configReadable ? 'unavailable' : 'forbidden') + '"]').count(), 1);
			assert.equal(await profiles.getByRole('button').count(), 0);
			await page.evaluate(() => pollOverview());
			assert.equal(await page.evaluate(() => mock.configCalls), 1, 'read failure is not repeatedly polled');
			assert.deepEqual(errors, []);
			await page.close();
		}
		{
			const { page, errors } = await harness(browser, { data: mesh([peer('11', 'Office', 'fresh', [])]), writable: true });
			await page.evaluate(() => renderManagement());
			const networks = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Local wireless networks', exact: true }) });
			assert.equal(await networks.getByText('Local Wi-Fi', { exact: true }).count(), 1);
			assert.equal(await page.getByText('No SSIDs selected for roaming assistance.', { exact: true }).count(), 1);
			assert.equal(await page.evaluate(() => mock.configCalls), 1);
			const peersSection = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Mesh peers', exact: true }) });
			await peersSection.getByRole('button', { name: 'Edit', exact: true }).click();
			let dialog = page.getByRole('dialog');
			assert.equal(await dialog.getByLabel('Stable profile ID', { exact: true }).count(), 0);
			assert.equal(await dialog.getByLabel(/BSSID/).count(), 0);
			assert.equal(await dialog.locator('input[type="text"]').count(), 3);
			assert.equal(await dialog.getByLabel('Allow roaming for Local Wi-Fi', { exact: true }).isChecked(), false);
			await dialog.getByLabel('Allow roaming for Local Wi-Fi', { exact: true }).check();
			await dialog.getByRole('button', { name: 'Save peer', exact: true }).click();
			await page.getByRole('dialog').waitFor({ state: 'detached' });
			assert.deepEqual(await page.evaluate(() => mock.operations), [{
				method: 'peer_save', args: ['192.168.50.11', '02:00:00:00:00:11', 'Office', ['Local Wi-Fi']]
			}], 'peer SSID selection is one authenticated operation without profile IDs or BSSIDs');
			const network = networks.getByRole('row').filter({ hasText: 'Local Wi-Fi' });
			assert.match(await network.textContent(), /Enabled/);
			assert.equal(await page.locator('.wrtmesh-roaming-state[data-state="pending"]').count(), 1);
			assert.equal(await page.getByText('Roaming enabled', { exact: true }).count(), 0,
				'saving a selected SSID does not claim an applied report');
			await network.getByRole('button', { name: 'Settings', exact: true }).click();
			dialog = page.getByRole('dialog');
			assert.equal(await dialog.locator('details').evaluate(node => node.open), false, 'timing defaults stay collapsed');
			assert.equal(await dialog.getByLabel('Stable profile ID', { exact: true }).count(), 0);
			await dialog.getByText('Advanced settings', { exact: true }).click();
			await dialog.getByLabel('Check interval (seconds)', { exact: true }).fill('120');
			await dialog.getByLabel('Neighbor report expiry (seconds)', { exact: true }).fill('180');
			const before = await page.evaluate(() => mock.operations.length);
			await dialog.getByRole('button', { name: 'Save network settings', exact: true }).click();
			assert.equal(await page.evaluate(() => mock.operations.length), before, 'invalid expiry is rejected before RPC');
			await page.getByRole('alert').filter({ hasText: 'Expiry must be at least three times' }).waitFor();
			await dialog.getByLabel('Neighbor report expiry (seconds)', { exact: true }).fill('600');
			await page.evaluate(() => { mock.networkReloadFail = true; });
			await dialog.getByRole('button', { name: 'Save network settings', exact: true }).click();
			await page.getByRole('dialog').waitFor({ state: 'detached' });
			await page.getByRole('alert').filter({ hasText: 'Settings were saved, but the roaming service could not reload.' }).waitFor();
			assert.deepEqual(await page.evaluate(() => mock.operations.at(-1)), {
				method: 'network_save', args: ['ssid_main', true, 120, 600]
			});
			const reads = await page.evaluate(() => mock.configCalls);
			await page.evaluate(() => {
				mock.data.peers[0].roaming = [{ ssid: 'Local Wi-Fi', state: 'active', age: 3,
					updated_at: 1762900000, local_applied: true }];
				mock.now += 16000;
				return pollOverview();
			});
			assert.equal(await page.getByText('Roaming enabled', { exact: true }).count(), 1);
			assert.equal(await page.getByText('Updated 3 seconds ago', { exact: true }).count(), 1);
			assert.equal(await page.locator('.wrtmesh-roaming-state[data-state="active"]').count(), 1);
			assert.equal(await page.evaluate(() => mock.configCalls), reads, 'status polling reuses sampled data without configuration RPC');
			assert.deepEqual(errors, []);
			await page.close();
		}
		{
			const value = peer('11', 'Office', 'fresh', []);
			value.ssids = ['Removed SSID'];
			const { page, errors } = await harness(browser, { data: mesh([value]), writable: true });
			await page.evaluate(() => renderManagement());
			await page.getByRole('button', { name: 'Edit', exact: true }).click();
			const dialog = page.getByRole('dialog');
			assert.equal(await dialog.getByLabel('Allow roaming for Removed SSID', { exact: true }).isChecked(), true);
			assert.equal(await dialog.getByText('This SSID is no longer configured locally.', { exact: true }).count(), 1);
			await dialog.getByLabel('Allow roaming for Removed SSID', { exact: true }).uncheck();
			await dialog.getByRole('button', { name: 'Save peer', exact: true }).click();
			await page.getByRole('dialog').waitFor({ state: 'detached' });
			assert.deepEqual(await page.evaluate(() => mock.operations.at(-1).args.at(-1)), [], 'explicit empty selection removes dormant policy');
			assert.deepEqual(errors, []);
			await page.close();
		}
		{
			const value = peer('11', 'Office', 'fresh', []);
			const states = ['pending', 'disabled', 'unavailable', 'stale', 'mismatch', 'unsupported', 'error'];
			const reasons = ['identity_pending', 'local_disabled', 'peer_unreachable', 'peer_reports_stale', 'identity_mismatch', 'peer_upgrade_required', 'apply_failed'];
			value.roaming = states.map((state, index) => ({ ssid: 'Network ' + index, state, reason: reasons[index], age: index, local_applied: false }));
			const { page, errors } = await harness(browser, { data: mesh([value]), mobile: true });
			await page.evaluate(() => renderManagement());
			for (const state of states)
				assert.equal(await page.locator('.wrtmesh-roaming-state[data-state="' + state + '"]').count(), 1, state);
			assert.equal(await page.getByText('Roaming enabled', { exact: true }).count(), 0);
			for (const label of ['Waiting for peer IP and MAC verification', 'Local assistance is disabled', 'Peer is unreachable', 'Peer neighbor reports expired', 'Peer IP and MAC do not match', 'Upgrade the peer to use automatic SSID roaming', 'Could not apply neighbor reports'])
				assert.equal(await page.getByText(label, { exact: true }).count(), 1, label);
			assert.equal(await page.locator('.wrtmesh-roaming-group').getByRole('heading', { name: 'Office (192.168.50.11)', exact: true }).count(), 1);
			const width = await page.locator('.wrtmesh-roaming-network').first().evaluate(node => node.getBoundingClientRect().width);
			assert(width <= 390, 'SSID state card fits a mobile viewport');
			await page.evaluate(() => {
				mock.data.peers[0].roaming[0] = { ssid: 'Network 0', state: 'unavailable', reason: 'peer_ssid_missing' };
				mock.now += 16000;
				return pollOverview();
			});
			assert.equal(await page.getByText('The peer has not provided roaming information for this SSID', { exact: true }).count(), 1);
			assert.equal(await page.getByText('The peer does not offer this SSID', { exact: true }).count(), 0);
			assert.deepEqual(errors, []);
			await page.close();
		}
		{
			const value = peer('11', 'Office AP name', 'fresh', [
				station('31', { name: 'Named client', ipv4: '192.168.68.152' }),
				station('32', { ipv4: '192.168.68.151' }),
				station('34', {}), station('40', {}),
				station('35', { mld: '02:00:00:00:02:35', links: [{ id: 0, mac: '02:00:00:00:02:33', bssid: '02:00:00:00:04:33' }] })
			]);
			const { page, errors } = await harness(browser, { data: mesh([value]), mobile: true });
			const labels = await page.locator('.wrtmesh-client-details > summary').allTextContents();
			assert(labels.includes('Named client'), 'reported client hostname takes priority over its IP');
			assert(labels.includes('192.168.68.151'), 'known client IPv4 is shown when hostname is absent');
			assert(labels.includes('192.168.68.153'), 'MLD link aliases can resolve host hint IPv4');
			assert(labels.includes('fd00::34'), 'IPv6 is used when no name or IPv4 is known');
			assert(labels.includes('?'), 'truly unknown client stays compact');
			assert(!labels.some(label => label.includes('Office AP name') || label.includes('02:00:00')), 'AP name and MAC never replace client identity');
			await page.evaluate(() => renderManagement());
			const meshLabels = await page.locator('.wrtmesh-host').allTextContents();
			for (const label of ['Named client', '192.168.68.151', '192.168.68.153', 'fd00::34', '?'])
				assert(meshLabels.includes(label), 'Mesh Host shares client fallback: ' + label);
			assert.deepEqual(errors, []);
			await page.close();
		}

		if (scripts.legacyWifi) {
			const { page, errors } = await harness(browser, { data: mesh(peers), legacyWifi: true });
			assert.equal(await page.getByRole('img', { name: 'Mesh topology' }).count(), 1);
			assert.equal(await page.locator('#wifi_assoclist_table tr').count(), 2);
			assert.deepEqual(errors, []);
			await page.close();
		}
		console.log('Chromium passed stock Overview, Mesh display, SSID selection, automatic local preparation, AP confirmation states, polling and failures.');
	} finally {
		await browser.close();
	}
})().catch(error => { console.error(error); process.exitCode = 1; });
