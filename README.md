# wrtmesh

wrtmesh provides OpenWrt multi-AP roaming assistance, station inventory and
topology.

## Install or upgrade

Use the signed noarch APK and matching public key from
[Releases](https://github.com/DictXiong/wrtmesh/releases). On APK-based C7
firmware, trust the verified release key in `/etc/apk/keys` and install with:

```sh
apk add ./wrtmesh-6.2.0-r1.apk
```

Package upgrades preserve local configuration in `/etc/config/xr_roaming` and
`/etc/config/xr_mesh`. Firmware sysupgrade also preserves these files when
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
edits and removals in `/etc/config/xr_mesh`. A removal there also masks an older
provisioned entry with the same bridge MAC. The local ESS definitions still
come from `/etc/config/xr_roaming`. For each ESS, the roaming worker uses the
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

## Behavior

Profiles are read from typed `config roaming` sections, with at most seventeen
profiles and a separate worker per enabled ESS. The installed configuration is
empty. A consumer may generate profiles such as the examples below:

| Profile | Wireless UCI section | Control interface | Maximum links |
| --- | --- | --- | --- |
| main | ssid_main | ap-mld0 | 3 |
| guest | ssid_guest | ap-mld1 | 2 |
| iot | ssid_iot | ap-iot | 1 |

Each profile declares `iface`, `mlo` (`0` or `1`) and `max_links` (`1`–`3`).
A single-link profile must declare `max_links '1'`. User IDs are case-sensitive
ASCII tokens starting with a letter, followed by letters, digits or underscores,
with a maximum length of 48. MLO interface names are bounded `ap-mld0` through
`ap-mld15`; single-link interfaces must be safe Linux interface names, at most
15 bytes. Collection binds its exact control socket, SSID, BSSID and real radio
link ID. A 5+6GHz MLO uses link IDs 1 and 2; numbering need not start at zero.

The package retains strict historical metadata only for old `main`, `battalion`,
`guest` and `iot` configurations that omit **both** `mlo` and `max_links`. Supplying
only one is rejected. This preserves package upgrades on the old AP layout while
allowing explicit metadata to use the new layout. New custom IDs require both.

The package reads each configured wireless section's actual SSID. It does not
create those sections, change their security, enable k/v, allocate addresses,
configure VLANs, enable FT or steer/kick clients. The AP deployment profile
must provide those settings separately. The example IoT profile is a single-link BSS. Node addresses, bridge MACs and permitted per-link peer BSSIDs come
from device provisioning, not from this package's source.

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
with existing C7 publishers. The main endpoint remains `/xr-roaming/own.json`;
other endpoints are `/xr-roaming/PROFILE/own.json`. The same ESS must use the
same stable profile ID on every AP; no speculative URL discovery is performed.
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
of the ESS workers. Set up the local ESS profile, verify its wireless section
and interface mapping, then enable it. Wi-Fi passwords belong to the wireless
deployment configuration.

Legacy roaming uses a DHCP address on `lan`/`br-lan.1`. With LuCI-managed peers,
the roaming worker also accepts a static address on `br-lan` or `br-lan.1` and
checks that the target is on the same subnet. The Mesh observer uses the primary
private IPv4 address of the management LAN. See
[XR1710G maintenance allocation](https://github.com/DictXiong/ImmortalWrt-for-Gemtek-brightspeed/blob/dicttech/xr1710g-ap/docs/dicttech-maintenance.md).

```sh
/etc/init.d/xr_roaming reload
/usr/lib/xr-roaming/helper.sh status main
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

`/etc/config/xr_roaming` and `/etc/config/xr_mesh` are conffiles. Installed code, the init script and
the `/www/xr-roaming` symlink are package-owned. The symlink targets the RAM
publication directory; private state, published JSON and locks live in `/tmp`
and must not be retained across upgrades.
Historical profile state paths are retained. Other IDs use a `profile-ID`
private directory, keeping arbitrary IDs such as `lock` or `peers` separate
from the main worker's internal files. These internal prefixes do not alter
the public URL or ESS identity.

## Firmware upgrades

Do not copy an entire old `/etc` or `/usr/lib/xr-roaming` over a new image.
Firmware upgrades should preserve configuration and device SSH host keys,
while obtaining runtime code from the new image's package set.

The public package intentionally contains no site inventory, credentials,
factory backup, SSH keys or runtime peer data.

## Local checks

Run the tests as root on Linux, in an isolated build/test environment with
Python 3, jq and the usual POSIX utilities:

```sh
python3 tests/check-xr-roaming-package.py
python3 tests/test-xr-roaming.py
python3 tests/test-xr-mesh.py --c7-rootfs PATH
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
