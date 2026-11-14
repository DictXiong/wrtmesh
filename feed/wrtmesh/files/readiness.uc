// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// Read-only readiness assessment. Method presence is an API capability, never
// proof that a feature is enabled. No client, package-name or platform guesses.
function flag(value) {
	if (type(value) == 'bool') return value;
	if (type(value) == 'int' && (value == 0 || value == 1)) return value == 1;
	if (type(value) == 'string') {
		value = lc(value);
		if (index(['1', 'true', 'yes', 'on'], value) >= 0) return true;
		if (index(['0', 'false', 'no', 'off'], value) >= 0) return false;
	}
	return null;
}

function iface(value) {
	return type(value) == 'string' && match(value, /^[A-Za-z0-9_.:-]{1,32}$/) ? value : null;
}

function mac(value) {
	if (type(value) != 'string') return null;
	value = lc(value);
	return match(value, /^[0-9a-f][02468ace](:[0-9a-f]{2}){5}$/) &&
		value != '00:00:00:00:00:00' ? value : null;
}

function array(value) { return type(value) == 'array' ? value : []; }

function call(bus, object, method) {
	try { return bus?.call(object, method, {}); } catch (e) { return null; }
}

function methods(bus, object) {
	let result;
	try { result = bus?.list(object); } catch (e) { return null; }
	// ucode ubus.list(exact_object) returns an array of signature objects.
	// [] means no matching object, not successful method enumeration.
	return type(result) == 'array' && length(result) == 1 &&
		type(result[0]) == 'object' ? result[0] : null;
}

function capability(signature, method) {
	return signature == null ? 'unknown' : method in signature ? 'supported' : 'unsupported';
}

function observed_flag(names) {
	for (let value in names) {
		// A counter or an aggregate rrm/wnm table is not an enabled flag.
		if (type(value) == 'bool' || (type(value) == 'int' && (value == 0 || value == 1)))
			return { state: value ? 'enabled' : 'disabled', source: 'explicit_status' };
	}
	return { state: 'unknown', source: null };
}

function own_report(report, ssid, addresses) {
	let addr = mac(report?.bssid), nr = report?.nr;
	if (!addr || !addresses[addr] || report.ssid != ssid || type(nr) != 'string' ||
	    length(nr) < 26 || length(nr) > 510 || length(nr) % 2 ||
	    !match(nr, /^[0-9a-f]+$/) || substr(nr, 0, 12) != replace(addr, /:/g, '') ||
	    !int(substr(nr, 20, 2), 16) || !int(substr(nr, 22, 2), 16)) return false;
	let offset = 26;
	while (offset < length(nr)) {
		if (length(nr) - offset < 4) return false;
		offset += 4 + int(substr(nr, offset + 2, 2), 16) * 2;
		if (offset > length(nr)) return false;
	}
	return true;
}

function cached_nr(sample, now, ssid, status) {
	let elapsed = type(sample?.seen) == 'int' && type(now) == 'int' ? now - sample.seen : null;
	if (elapsed == null || elapsed < 0 || elapsed >= 95) return false;
	let addresses = {};
	for (let value in [status.bssid, ...map(array(status.links), link => link.bssid)]) {
		let addr = mac(value);
		if (addr) addresses[addr] = true;
	}
	for (let network in array(sample.data?.roaming)) {
		if (network.ssid != ssid) continue;
		for (let part in array(network.parts)) {
			if (type(part.age) != 'int' || part.age < 0 || type(part.ttl) != 'int' ||
			    part.ttl < 95 || part.ttl > 900 || elapsed + part.age >= part.ttl ||
			    type(part.digest) != 'string' || !match(part.digest, /^[0-9a-f]{64}$/) ||
			    part.envelope?.version != 1 || part.envelope.ssid != ssid) continue;
			for (let report in array(part.envelope.reports))
				if (own_report(report, ssid, addresses)) return true;
		}
	}
	return false;
}

function interface_status(bus, name, ssid, sample, now) {
	let object = 'hostapd.' + name;
	let signature = methods(bus, object);
	let status = call(bus, object, 'get_status');
	status = type(status) == 'object' ? status : {};
	let enabled = status.status == 'ENABLED' && status.ssid == ssid;
	let unknown = { state: 'unknown', source: null };
	let runtime = {
		nr: { ...unknown }, beacon: { ...unknown }, btm: { ...unknown }, ft: { ...unknown }
	};
	if (enabled) {
		runtime.nr = observed_flag([status.rrm_neighbor_report, status.neighbor_report, status.rrm?.neighbor_report]);
		runtime.beacon = observed_flag([status.rrm_beacon_report, status.beacon_report, status.rrm?.beacon_report]);
		runtime.btm = observed_flag([status.bss_transition, status.wnm?.bss_transition]);
		runtime.ft = observed_flag([status.ieee80211r]);
		if (runtime.nr.state == 'unknown' && cached_nr(sample, now, ssid, status))
			runtime.nr = { state: 'enabled', source: 'cached_neighbor_report' };
	}
	return { iface: name, object, status: enabled ? 'enabled' : status.status == 'DISABLED' ? 'disabled' : 'unknown',
		capabilities: { nr_api: capability(signature, 'rrm_nr_set'),
			beacon_api: capability(signature, 'rrm_beacon_req'), btm_api: capability(signature, 'bss_transition_request') }, runtime };
}

export function collect(config, bus, sample, now, ownership) {
	ownership = index(['readonly', 'ordinary'], ownership) >= 0 ? ownership : 'unknown';
	let wireless = call(bus, 'network.wireless', 'status');
	let mapping = {}, by_name = {}, aps = [], cache = {};
	for (let radio in values(type(wireless) == 'object' ? wireless : {})) {
		for (let item in array(radio.interfaces)) {
			let name = iface(item.ifname);
			if (!name) continue;
			by_name[name] = true;
			if (type(item.section) == 'string') {
				mapping[item.section] ??= {};
				mapping[item.section][name] = true;
			}
		}
	}
	try {
		let read = config.foreach('wireless', 'wifi-iface', s => {
			if (s.mode != 'ap') return;
			let configuration = {};
			for (let key in ['ieee80211k', 'rrm_neighbor_report', 'rrm_beacon_report', 'bss_transition', 'ieee80211r', 'ft_over_ds'])
				configuration[key] = flag(s[key]);
			let k = s.ieee80211k == null ? false : configuration.ieee80211k;
			configuration.nr = s.rrm_neighbor_report == null ? k : configuration.rrm_neighbor_report;
			configuration.beacon = s.rrm_beacon_report == null ? k : configuration.rrm_beacon_report;
			let names = keys(mapping[s['.name']] ?? {}), origin = 'section';
			// An explicitly configured interface can identify old netifd entries
			// that omit section. Never guess by duplicated SSID or MLO suffix.
			if (!length(names) && iface(s.ifname) && by_name[s.ifname]) {
				names = [s.ifname]; origin = 'explicit_ifname';
			}
			let ssid = type(s.ssid) == 'string' ? s.ssid : '';
			let device = type(s.device) == 'string' ? s.device : type(s.device) == 'array' ? filter(s.device, value => type(value) == 'string') : null;
			let devices = filter(type(device) == 'string' ? split(device, /[[:space:]]+/) : array(device), iface);
			let interfaces = [];
			for (let name in names) {
				let key = name + '\n' + ssid;
				cache[key] ??= interface_status(bus, name, ssid, sample, now);
				push(interfaces, { ...cache[key], mapping: origin });
			}
			push(aps, { section: s['.name'], ssid, mode: 'ap', device, devices, disabled: flag(s.disabled) == true,
				interfaces, configuration, ownership });
		});
		if (read == null) return { version: 1, error: 'configuration_unavailable', aps: [] };
	} catch (e) {
		return { version: 1, error: 'configuration_unavailable', aps: [] };
	}
	return { version: 1, aps };
}
