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
	mesh: source('xrmesh.js'),
	management: source('xrmesh-view.js', 'view/network/xrmesh.js')
};
assert(!scripts.wifi.includes('xrmesh'), 'provide the unpatched LuCI source');
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
	online: status === 'fresh', age, updated_at: age == null ? null : 1762900000 - age, profiles: {},
	data: status === 'fresh' ? { name, gateway, stations } : null
});
const mesh = peers => ({ address: '192.168.50.2', local, local_age: 0, peers, profiles: [] });
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
	legacyWifi = false }) {
	const page = await browser.newPage({ viewport: { width: mobile ? 390 : 1300, height: 940 } });
	const errors = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.route('**/*', route => {
		const url = new URL(route.request().url());
		if (url.hostname !== 'wrtmesh.test')
			return route.abort();
		if (url.pathname === '/')
			return route.fulfill({ contentType: 'text/html', body: '<main></main>' });
		if (url.pathname.endsWith('/xrmesh.css'))
			return route.fulfill({ contentType: 'text/css', body: source('xrmesh.css') });
		return route.fulfill({ status: 404, body: '' });
	});
	await page.goto('http://wrtmesh.test/');
	await page.evaluate(async ({ scripts, installed, data, writable, readable, legacyWifi }) => {
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
			(typeof fn === 'string' ? ctx[fn] : fn).bind(ctx, ...args) };
		window.uci = { get: () => null, load: async () => ({}) };
		window.firewall = { getZones: async () => [] };
		window.poll = { add: fn => { window.pollOverview = fn; } };
		window.mock = { data, calls: 0, now: Date.now() };
		Date.now = () => window.mock.now;
		window.rpc = { declare: ({ object, method, expect }) => async (...args) => {
			if (object === 'xrmesh' && method === 'status') {
				window.mock.calls++;
				if (window.mock.data === null)
					throw new Error('RPC unavailable');
				return window.mock.data;
			}
			if (object === 'session' && method === 'access') {
				const access = args.includes('save') ? writable : args.includes('status') ? readable : true;
				return expect?.access !== undefined ? access : { access };
			}
			throw new Error('Unexpected RPC ' + object + '.' + method);
		} };
		const hosts = {
			getHostnameByMACAddr: mac => mac.toLowerCase().endsWith(':10') ? 'Example client' : null,
			getIPAddrByMACAddr: () => null, getIP6AddrByMACAddr: () => null
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
		window.xrmesh = modules.xrmesh = new Function(scripts.mesh)();
		modules['view.status.include.60_wifi'] = new Function(legacyWifi ? scripts.legacyWifi : scripts.wifi)();
		if (installed)
			modules['view.status.include.65_wrtmesh'] = new Function(scripts.include)();
		const overview = new Function(scripts.overview)();
		document.querySelector('main').append(await overview.render(await overview.load()));
		window.renderManagement = async () => {
			const management = new Function(scripts.management)();
			document.querySelector('main').replaceChildren(management.render(await management.load()));
		};
	}, { scripts, installed, data, writable, readable, legacyWifi });
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
		if (scripts.legacyWifi) {
			const { page, errors } = await harness(browser, { data: mesh(peers), legacyWifi: true });
			assert.equal(await page.getByRole('img', { name: 'Mesh topology' }).count(), 1);
			assert.equal(await page.locator('#wifi_assoclist_table tr').count(), 2);
			assert.deepEqual(errors, []);
			await page.close();
		}
		console.log('Chromium passed stock Overview, package include, Mesh management, multi-link overlap, refresh and access failures.');
	} finally {
		await browser.close();
	}
})().catch(error => { console.error(error); process.exitCode = 1; });
