# wrtmesh

wrtmesh provides OpenWrt multi-AP roaming assistance, station inventory and
topology.

## Install or upgrade

Use the signed noarch APK and matching public key from
[Releases](https://github.com/DictXiong/wrtmesh/releases). On APK-based OpenWrt
firmware, trust the verified release key in `/etc/apk/keys` and install with:

```sh
apk add ./wrtmesh-6.4.4-r1.apk
```

Package upgrades preserve local configuration in `/etc/config/wrtmesh` and
`/etc/config/wrtmesh_peers`. Firmware sysupgrade also preserves these files when
settings are retained.

The APK provides **Network → Mesh** and the **Mesh** section of **Status →
Overview**. The latter uses LuCI's status include loader and belongs to the
package. After installing or removing the APK, reload any already-open LuCI
tabs. To remove an installation that replaced the legacy roaming package,
run `apk del wrtmesh xr-roaming` to clear both possible APK world entries.
Firmware that shipped the former Overview patch needs a firmware upgrade to
remove that embedded integration.

For firmware or SDK builds, add this repository as an OpenWrt feed, install
the `wrtmesh` feed entry and select `CONFIG_PACKAGE_wrtmesh=y` (image) or `=m`
(APK). The package depends on `luci-mod-status` for the Overview loader.

The roaming worker uses shell and jq. `hostapd-utils` supplies the standard
`/usr/sbin/hostapd_cli`; no private binary or historical binary hash is carried
in this package. Use a matched, tested firmware/package set. The supported
server is the C7 hostapd implementation with one ubus object per MLD and
per-link control sockets. A successful APK installation alone does not prove
compatibility with another hostapd or firmware version. Runtime collection
strictly validates socket status, link identity and neighbor-report contents.

## LuCI Mesh

Open **Network → Mesh** to discover, add, edit or remove peers. Discovery uses
OpenWrt's `umdns` on the management LAN. A node can also be entered manually by
LAN IPv4 address and bridge MAC. Verify that identity before saving.
Enroll peers on both devices to exchange station and topology snapshots.

In each peer, select the SSIDs allowed to use roaming assistance. Required local
workers are prepared automatically. The UI needs neither profile IDs nor BSSID
lists. Leave every SSID unchecked to exchange only station and topology data.
BSSIDs and MLO links are learned from the peer and refreshed automatically.
Only exact SSID matches with compatible reported wireless security are used.
SSID names preserve case, Unicode and whitespace; they are not normalized.
Multiple radios using the same local network and security can share an SSID.
Conflicting same-name configurations are reported as ambiguous.

The list includes previously provisioned peers. LuCI stores additions and
per-peer SSID selections in `/etc/config/wrtmesh_peers`; local collector settings
are stored in `/etc/config/wrtmesh`. Internal UCI worker names are generated or
reused automatically and do not need to match between nodes. A peer removal
also masks an older provisioned entry with the same bridge MAC.

The observer samples associated, authorized Wi-Fi stations via hostapd and
uses netifd, ARP and bridge forwarding tables for topology. When possible, the
map labels the bridge, local port and peer-side port. Forwarding data can point
through a switch, and entries age out. The map shows unknown ports when the
available evidence is incomplete. PPP dial-up next hops are omitted.

The **Mesh** section in Overview shows the topology and a compact remote
client table ordered by access node. SSID/node, client MAC, host/IP, signal and
AP RX/TX are visible without opening client details. The host label prefers its
name, then IPv4, then IPv6, and shows `?` only when all are unknown; the MAC
remains visible for identification. Node snapshot freshness and failure notices
are separate from the table. During roaming, overlapping fresh records are
shown once using the freshest observation when a reliable identity matches.
Links from different APs are never combined. The native wireless table continues
to show stations associated with the local AP.

**Network → Mesh** uses the same compact client table and adds the reported
wireless interface beside each SSID/node. Each client occupies one row; MLO
links do not add subrows or repeat AP radio attributes. Missing or invalid RSSI
shows `—`; valid negative RSSI and the client's own AP RX/TX measurements are
preserved. Rates are negotiated link rates from the AP's perspective, not
measured throughput. Both tables share rendering and host/IP formatting and
adapt to narrow screens without per-client disclosure controls.

**SSID roaming assistance** groups the existing peer states by SSID. The local
radio summary appears once, with each peer's own summary beside its status.
Band and channel come from current AP neighbor reports, deduplicated by BSSID;
distinct BSSIDs on the same band/channel show a count. Expired or unavailable
reports are marked, and unknown operating classes do not imply a guessed band.
These reports do not identify MLO membership or remote interface/link IDs, so
the summary does not infer them from report counts or client observations.

The observer runs on a 30-second schedule. After 95 seconds without a new
revision, the last snapshot stops contributing station and topology data.
Overview shows when each node was last observed and distinguishes fresh
empty snapshots from stale data, unreachable nodes, and denied requests.
It caps the local inventory at 15 peers and each node snapshot at 256
stations. Discovery advertises only the service. The HTTP
identity response includes the bridge MAC, node name and available roaming
metadata. Station and topology responses require a registered source IPv4
address on the management LAN. The HTTP exchange uses plaintext and offers no
cryptographic authentication. Local peer edits go through LuCI's authenticated
RPC interface. Use the existing firewall policy to isolate the management LAN.

## SSID roaming

Open **Network → Mesh**, add a peer and select its roaming SSIDs. The choices
come from actual local AP `wifi-iface` sections. There are no main/guest/IoT
presets. New peer settings automatically create or enable the necessary local
controllers. The local wireless list offers an optional settings dialog;
check/expiry timers are under **Advanced settings**. Wireless SSIDs, passwords,
VLANs and FT belong to LuCI's standard **Network → Wireless** settings.

The Mesh page shows one status per peer and selected SSID. **Roaming enabled**
means current neighbor information has been validated, synchronized and applied
to the local hostapd object. Status is derived from worker application evidence
matching the current report generation; a selected checkbox or an online peer
alone never produces this state. Pending, expired, identity mismatch, unavailable
AP, incompatible security and unsupported older-peer states have distinct
reasons and update times.

Automatic candidate acceptance requires the configured peer IP to match its
bridge MAC in the management LAN neighbor cache as well as its HTTP identity.
Missing/incomplete or conflicting ARP evidence keeps the relationship pending
or rejects it. The observer reuses its existing neighbor dump; it does not
flood the network with discovery probes. Matching IP/MAC is input validation,
not cryptographic authentication. Peer traffic remains plaintext and cannot
write local configuration. Passwords, keys and credential hashes are never
exchanged. Reported security metadata is a whitelist of nonsecret settings;
it cannot prove that credentials are identical.

Candidate reports ride the existing bounded Mesh snapshots. Radio/link changes
update the candidate list without new per-SSID HTTP polling or repeated full
local NR collection. Expired, disabled, conflicting or identity-mismatched
sources are withdrawn. Each source worker retains its own publication revision
and age so an active observer cannot keep a frozen publisher fresh. The
receiving worker independently validates reports, recomputes their digest and
rejects a changed payload under an unchanged publication revision.

At most seventeen local controllers and fifteen peers are supported. Each
peer/SSID can contribute at most three distinct link reports. Explicit local
interface mapping comes from netifd and hostapd; ambiguous mappings are
rejected. Historical typed `config roaming` sections remain supported, but
users no longer choose or coordinate their internal IDs. Unsupported older
peers retain station/topology display where possible; automatic SSID roaming
shows that a peer upgrade is needed. Migrated pinned legacy relationships
continue to use their earlier bounded protocol.

### Declarative provisioning

Starting with 6.4.1, a provisioner can put automatic peer policy in
`/etc/config/wrtmesh`. Each peer needs its management LAN IPv4, bridge MAC,
`option ssid_mode 'auto'` and a `list roam_ssid` for each allowed SSID. Local
`config roaming` sections describe only local collectors; their internal names
do not need to match another node. Do not provision learned BSSIDs.

```uci
config peer 'managed_peer'
        option address '192.168.1.2'
        option bridge_mac '02:00:00:00:00:02'
        option ssid_mode 'auto'
        list roam_ssid 'Home'
```

The provisioner must also enable the local collectors for the selected SSIDs.
LuCI continues to own `/etc/config/wrtmesh_peers`; its per-MAC edits and deletion
markers take precedence over provisioned policy. Keep that file outside the
provisioner's ownership so software installation and configuration deployments
preserve local overrides. An empty SSID selection retains station and topology
exchange without enabling roaming. Both sources use the same cache validation,
IP/MAC checks, expiry rules and hostapd application evidence.

## Behavior

The default schedule is a 30-second local check and heartbeat, and a
300-second strict collection/actual-table audit. Automatic candidates reuse
the observer's 30-second peer snapshots at each worker check; no extra
per-SSID HTTP request is made. The snapshot expires after 95 seconds. Individual
report workers also carry bounded lifetimes based on their check interval
(95–900 seconds), retaining frozen-generation age across fresh observer
snapshots. A longer check interval does not incorrectly expire after 95 seconds
while its observer remains healthy. Station-count changes do not invalidate AP
metadata.

Migrated pinned peers keep their 60-second fetch and default 180-second
revision expiry. The legacy configuration names one explicit peer per profile
or accepts `peer_mode 'fleet'`, a `peers` list, and shared `config peer` sections
with addresses, bridge identities and old per-profile BSSIDs. Each peer has an
independent revision TTL and cache; the complete fresh union is
installed once per hostapd object. A single AP with no peers is supported.

The fleet is bounded to 16 APs. The matching firmware increases both hostapd
control-reply buffers to 64 KiB so that the validated bounded neighbor list can
be read back without truncation. The private cache is repaired after missing
aggregate files and is discarded if a local BSSID change would alias an old
peer. The original single-peer configuration remains compatible.

Legacy public neighbor JSON remains version 1. Its main endpoint is
`/wrtmesh/own.json`; other legacy endpoints are `/wrtmesh/PROFILE/own.json`.
Only this older path-based protocol needs coordinated profile IDs; the new
Mesh snapshot matches SSIDs directly, regardless of internal worker names. A 404 response permits one fallback to
the predecessor `/xr-roaming/` path; a validated legacy choice is cached.
Timeouts, denied requests and invalid payloads do not trigger fallback.
Peer link counts may differ from the local AP's count, bounded to three and to
the automatically validated per-SSID candidate set, or the old pinned allowlist
for migrated relationships. Legacy HTTP bodies retain their 16 KiB limit;
Mesh snapshots and hostapd control replies remain bounded to 64 KiB.

Metadata is fetched over HTTP on the trusted native LAN. Exact peer identity
and BSSID checks are input validation, not cryptographic peer authentication.
Keep the metadata endpoint inaccessible from the guest network as part of the
AP's management-input policy. Do not run another neighbor-table controller,
such as usteer or DAWN, against the same hostapd objects.

## Configuration and lifecycle

No ESS profile or peer ships predefined. The procd observer runs independently
of the ESS workers. Set up local profiles and peers in **Network → Mesh**.
Configuration writes use authenticated local RPC methods with separate read
and write ACLs. The plaintext peer endpoint has no configuration operations.

Legacy roaming uses a DHCP address on `lan`/`br-lan.1`. With LuCI-managed peers,
the roaming worker also accepts a static address on `br-lan` or `br-lan.1` and
checks that the target is on the same subnet. The Mesh observer uses the primary
private IPv4 address of the management LAN.

```sh
/etc/init.d/wrtmesh reload
/usr/lib/wrtmesh/helper.sh status main
```

The CLI IDs are internal diagnostic identifiers. `helper.sh profiles` lists
enabled internal workers after validating the complete typed section set,
token bounds and the seventeen-controller limit. Status is read-only
and does not take the worker's exclusive lock. Reload reconciles enabled procd
instances and invalidates configuration caches without restarting wireless.

Before a live package upgrade, the pre-install hook stops the old service and
waits for existing old and new worker locks, including profiles absent from the
new configuration. It refuses a symlinked or still-held lock
rather than replacing modules beneath a running worker. Offline rootfs
installation respects `IPKG_INSTROOT` and performs no target service calls.
Package installation does not run `uci-defaults` or commit unrelated UCI edits.

Earlier configurations named `/etc/config/xr_roaming` and `/etc/config/xr_mesh`
are migrated automatically on installation or first service start after a
firmware upgrade. Raw originals are saved with mode 0600 under
`/etc/wrtmesh/migration/roaming.uci` and `peers.uci`; APK `.apk-save` copies have
separate backups. New populated canonical files take precedence. Migration is
idempotent, stages both copies and refuses symlinks or conflicting backups.
The old active files are removed only after their contents have been preserved.
The canonical UCI files survive sysupgrade when settings are retained; the
extra migration archive is not automatically included in sysupgrade backups.

All active configuration, service, library, RPC, frontend and discovery names
use `wrtmesh`. The package keeps only the old read-only HTTP paths and discovery
recognition needed to communicate with earlier nodes, plus the predecessor
package `PROVIDES` entry needed for APK replacement. There is no old local
configuration, service or RPC alias. External configuration generators must
use the new paths and service name when deploying this version.

`/etc/config/wrtmesh` and `/etc/config/wrtmesh_peers` are conffiles. Installed code, the init script and
the `/www/wrtmesh` symlink are package-owned. The symlink targets the RAM
publication directory; private state, published JSON and locks live in `/tmp`
and must not be retained across upgrades.
Historical profile state paths are retained. Other IDs use a `profile-ID`
private directory, keeping arbitrary IDs such as `lock` or `peers` separate
from the main worker's internal files. These internal prefixes do not alter
the public URL or ESS identity.

## Firmware upgrades

Do not copy an entire old `/etc` or `/usr/lib/wrtmesh` over a new image.
Firmware upgrades should preserve configuration and device SSH host keys,
while obtaining runtime code from the new image's package set.

The public package intentionally contains no site inventory, credentials,
factory backup, SSH keys or runtime peer data.

## Local checks

Run the tests as root on Linux, in an isolated build/test environment with
Python 3, jq and the usual POSIX utilities:

```sh
python3 tests/check-wrtmesh-package.py
python3 tests/test-roaming.py
python3 tests/test-mesh.py --c7-rootfs PATH
python3 tests/test-configuration.py --c7-rootfs PATH
python3 tests/test-ssid-policy.py --c7-rootfs PATH
```

The package checker covers unconfigured defaults and lifecycle/lock handling without
calling a real service. The second stages the actual package runtime into
synthetic command/socket fixtures. Supplying `--c7-rootfs PATH` additionally
exercises C7 BusyBox ash and its slim jq through `qemu-aarch64`; without it the
two target-specific checks are explicitly skipped. Root is required because
the helper intentionally validates root ownership of private state.

After building and extracting an APK to a separate directory, add
`--installed-root PATH` to the package checker to verify that its runtime and
RAM symlink match the source. These local checks do not substitute for guarded
live installation and actual hostapd/procd acceptance on the AP.

With Playwright and Chromium installed, run the Overview include loader and
both views in a browser using fixture RPC responses:

```sh
node tests/test-luci-browser.cjs PATH_TO_UNPATCHED_LUCI_FEED
```

Pass an unpacked APK root as a second argument to exercise its installed
copies of the modules. Set `WRTMESH_PLAYWRIGHT` or `WRTMESH_CHROMIUM` to
use a non-default module or browser executable. The harness uses LuCI's
Bootstrap desktop/mobile styles by default. For GlassTheme acceptance, set
`WRTMESH_THEME_ROOT` to the static asset directory containing
`glass/css/cascade.css`. Set `WRTMESH_SCREENSHOTS` to an output directory to
capture desktop/mobile Overview and Mesh views with synthetic client data.

Build a standalone signed APK with the checksum-pinned SDK:

```sh
python3 ci/build-package.py --work /tmp/wrtmesh-sdk --output artifacts
```

The tag workflow builds the APK, checks replacement with APK 3 and publishes
the package, public signing key, signed index, checksums and provenance.
