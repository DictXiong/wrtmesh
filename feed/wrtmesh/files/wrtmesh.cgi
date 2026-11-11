#!/usr/bin/ucode
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

import * as ubus from 'ubus';
import * as mesh from '/usr/lib/wrtmesh/mesh.uc';

function reply(status, data) {
	printf('Status: %s\r\nContent-Type: application/json\r\nCache-Control: no-store\r\n\r\n%J\n', status, data);
	exit(0);
}

let query = getenv('QUERY_STRING') ?? '';
if (getenv('REQUEST_METHOD') != 'GET' || (query != '' && query != 'identity=1'))
	reply('405 Method Not Allowed', {});

let bus = ubus.connect(null, 1);
let lan = mesh.lan_status(bus);
let remote = getenv('REMOTE_ADDR');
if (!mesh.on_lan(lan, remote) || getenv('SERVER_ADDR') != lan.address)
	reply('403 Forbidden', {});

let config = mesh.cursor();
let node = mesh.identity(bus);
if (!node.bridge_mac)
	reply('503 Service Unavailable', {});

if (query == 'identity=1')
	reply('200 OK', { version: 1, ...node, profiles: mesh.advertised_profiles(config, node.bridge_mac) });

let peers = mesh.peer_inventory(config, mesh.overrides(config)).peers;
if (!length(filter(peers, p => p.address == remote && p.bridge_mac != node.bridge_mac)))
	reply('403 Forbidden', {});

let local = mesh.read_json(mesh.state + '/local.json', mesh.response_limit);
let age = mesh.age(local, mesh.uptime());
if (age == null || age >= mesh.ttl || local.data?.bridge_mac != node.bridge_mac)
	reply('503 Service Unavailable', {});

reply('200 OK', { ...local.data, sample_age: age });
