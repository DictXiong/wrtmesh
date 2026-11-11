# wrtmesh

wrtmesh provides OpenWrt multi-AP roaming assistance, station inventory and
topology.

## Install or upgrade

Use the signed noarch APK and matching public key from
[Releases](https://github.com/DictXiong/wrtmesh/releases). On APK-based OpenWrt
firmware, trust the verified release key in `/etc/apk/keys` and install with:

```sh
apk add ./wrtmesh-6.3.0-r1.apk
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
LAN IPv4 address and bridge MAC. Review any discovered BSSIDs before saving.
Enroll peers on both devices to exchange station and topology snapshots.

The list includes previously provisioned peers. LuCI stores local additions,
edits and removals in `/etc/config/wrtmesh_peers`. A removal there also masks an older
provisioned entry with the same bridge MAC. Local roaming profiles are also managed on this page and stored in
`/etc/config/wrtmesh`. For each ESS, the roaming worker uses the
peer BSSIDs explicitly approved in LuCI or the existing provisioning. A peer
can share station and topology snapshots with no approved BSSIDs.

The observer samples associated, authorized Wi-Fi stations via hostapd and
uses netifd, ARP and bridge forwarding tables for topology. When possible, the
map labels the bridge, local port and peer-side port. Forwarding data can point
through a switch, and entries age out. The map shows unknown ports when the
available evidence is incomplete. PPP dial-up next hops are omitted.

The **Mesh** section in Overview shows the topology and a separate remote
wireless client table grouped by access node. Client details include reported
addresses and link identifiers when available. RX and TX are negotiated link
rates from the AP's perspective. A report with an explicit MLD identity can
contain several links. During roaming, overlapping fresh records are shown
once using the freshest observation when a reliable identity matches. Links
from different APs are never combined. The native wireless table continues
to show stations associated with the local AP.

The observer runs on a 30-second schedule. After 95 seconds without a new
revision, the last snapshot stops contributing station and topology data.
Overview shows when each node was last observed and distinguishes fresh
empty snapshots from stale data, unreachable nodes, and denied requests.
It caps the local inventory at 15 peers and each node snapshot at 256
stations. Discovery advertises only the service. The HTTP
identity response includes the bridge MAC, node name and available roaming
BSSIDs. Station and topology responses require a registered source IPv4
address on the management LAN. The HTTP exchange uses plaintext and offers no
cryptographic authentication. Local peer edits go through LuCI's authenticated
RPC interface. Use the existing firewall policy to isolate the management LAN.

## Local roaming profiles

In **Network → Mesh → Local roaming profiles**, add a profile, select a local
SSID, and enable or disable roaming assistance. The SSID selector reads actual
`wifi-iface` sections from this router. There are no predefined main/guest/IoT
SSIDs. Creating, editing and removing profiles, timing settings and peer BSSID
approvals all have LuCI controls; editing a configuration file is optional.
Wireless SSIDs and passwords themselves are configured in LuCI's standard
**Network → Wireless** page.

The runtime interface, MLO mode and link count are inferred from netifd's actual
wireless status. Enabling requires an active AP with a consistent, supported
mapping; an inactive SSID may be saved as a disabled profile. No guessed
interface names are written. Two enabled profiles cannot claim the same SSID
section or runtime control interface. Both the local check interval (30–300
seconds) and peer expiry (180–1800 seconds, at least three intervals) are
validated on the server as well as in the form.

Each profile has a stable ID shared by nodes participating in the same ESS.
Choose that ID when creating it; it is unchanged by later SSID edits. IDs are
case-sensitive ASCII tokens starting with a letter, followed by letters,
digits or underscores, up to 48 characters. At most seventeen profiles are
supported. Each enabled profile has an independent worker. Removing a profile
stops its worker; peer BSSID approvals for that ID remain inactive and can be
reused if the same ID is added later.

Advanced consumers can generate typed `config roaming` sections in
`/etc/config/wrtmesh`, declaring the wireless `section`, `iface`, `mlo` (`0` or
`1`), `max_links` (`1`–`3`), `enabled`, `interval` and `ttl`. Explicit interface
names must be safe Linux interface names of at most 15 bytes. A single-link
profile declares one link. Collection verifies the exact configured control
socket, SSID, BSSID and actual radio link ID. MLO link numbering need not start
at zero. Historical interface defaults are accepted only for migrated profiles
that omit both MLO metadata fields; LuCI writes explicit runtime metadata.

The package reads the selected wireless section's actual SSID. It does not
create wireless sections, change their security, configure VLANs, enable FT or
steer/kick clients. Configure these through the standard wireless/network pages.
Peer addresses, bridge MACs and approved per-link BSSIDs belong to local
configuration and are never predefined in the package.

## Behavior

The default schedule is a 30-second local check and heartbeat, a 60-second
peer fetch, and a 300-second strict collection/actual-table audit. Peer data
expires after 180 seconds without a newly observed revision. Station-count
changes do not invalidate AP metadata. The legacy configuration names one
explicitly configured peer per profile. The helper also accepts the fleet configuration generated by
the consumer Nix AP profile: `peer_mode 'fleet'`, a `peers` list, and shared `config peer`
sections containing addresses, bridge identities and per-profile BSSIDs. Each
peer has an independent revision TTL and cache; the complete fresh union is
installed once per hostapd object. A single AP with no peers is supported.

The fleet is bounded to 16 APs. The matching firmware increases both hostapd
control-reply buffers to 64 KiB so that the validated bounded neighbor list can
be read back without truncation. The private cache is repaired after missing
aggregate files and is discarded if a local BSSID change would alias an old
peer. The original single-peer configuration remains compatible.

Public neighbor JSON remains version 1, containing no local interface name or
profile metadata. Therefore a peer's interface rename does not break exchange
with existing v1 publishers. The primary endpoint is `/wrtmesh/own.json`;
other endpoints are `/wrtmesh/PROFILE/own.json`. The same ESS must use the
same stable profile ID on every AP. A 404 response permits one fallback to
the predecessor `/xr-roaming/` path; a validated legacy choice is cached.
Timeouts, denied requests and invalid payloads do not trigger fallback.
Peer link counts may differ from the local AP's count, bounded to three and to
the configured peer BSSID allowlist. HTTP bodies retain their stricter 16 KiB
limit; hostapd control replies remain bounded to 64 KiB.

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

Use another configured profile ID for other ESSes. `helper.sh profiles` lists
enabled profiles after validating the complete typed section set, duplicate
IDs, token bounds and the seventeen-profile limit. Status is read-only
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
```

The first command checks unconfigured defaults and lifecycle/lock handling without
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
use a non-default module or browser executable.

Build a standalone signed APK with the checksum-pinned SDK:

```sh
python3 ci/build-package.py --work /tmp/wrtmesh-sdk --output artifacts
```

The tag workflow builds the APK, checks replacement with APK 3 and publishes
the package, public signing key, signed index, checksums and provenance.
