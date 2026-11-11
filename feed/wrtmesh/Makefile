# SPDX-License-Identifier: GPL-2.0-only

WRTMESH_SOURCE_DIR:=$(abspath $(dir $(realpath $(lastword $(MAKEFILE_LIST))))/../..)
include $(TOPDIR)/rules.mk

PKG_NAME:=wrtmesh
PKG_VERSION:=$(strip $(shell cat $(WRTMESH_SOURCE_DIR)/VERSION))
PKG_RELEASE:=1
PKG_LICENSE:=GPL-2.0-only
PKG_BUILD_DEPENDS:=luci-base/host

include $(INCLUDE_DIR)/package.mk

define Package/wrtmesh
  PKGARCH:=all
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=WirelessAPD
  TITLE:=Multi-AP roaming assistance and Mesh visibility
  URL:=https://github.com/DictXiong/wrtmesh
  PROVIDES:=xr-roaming
  DEPENDS:=+hostapd-utils +jq +curl +coreutils-timeout +flock +uci +ubus +uhttpd
  DEPENDS+=+umdns +ucode-mod-fs +ucode-mod-ubus +ucode-mod-uci +ucode-mod-rtnl +rpcd +rpcd-mod-ucode +luci-mod-network +luci-mod-status
endef

define Package/wrtmesh/description
  Multi-AP peer discovery, station and topology visibility, and wired-backhaul
  roaming assistance for supported hostapd builds.
endef

define Package/wrtmesh/conffiles
/etc/config/wrtmesh
/etc/config/wrtmesh_peers
endef

define Build/Prepare
endef

define Build/Configure
endef

define Build/Compile
	$(INSTALL_DIR) $(PKG_BUILD_DIR)
	$(STAGING_DIR_HOSTPKG)/bin/po2lmo ./po/zh_Hans/wrtmesh.po $(PKG_BUILD_DIR)/wrtmesh.zh-cn.lmo
endef

define Package/wrtmesh/preinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] && exit 0
[ "$${IPKG_NO_SCRIPT}" = 1 ] && exit 0
[ ! -L /etc ] && [ ! -L /etc/config ] || exit 1
was_running=
restore_service() {
	for service in $$was_running; do
		[ ! -x "$$service" ] || "$$service" start >/dev/null 2>&1 || true
	done
}
for service in /etc/init.d/wrtmesh /etc/init.d/xr_roaming; do
	if [ -x "$$service" ] && "$$service" status >/dev/null 2>&1; then
		was_running="$$was_running $$service"
	fi
done
for service in /etc/init.d/wrtmesh /etc/init.d/xr_roaming; do
	[ ! -x "$$service" ] || "$$service" stop || { restore_service; exit 1; }
done
# An old shell must not continue running while its jq modules are replaced.
# A package-name transition may already have removed the old init script.
count=0
# The main lock and every old/new profile lock live at depth zero or one.
# Do not infer the old worker set from the newly supplied UCI configuration.
for state in /tmp/wrtmesh-private /tmp/wrtmesh-private/* /tmp/xr-roaming-private /tmp/xr-roaming-private/*; do
	if [ -L "$$state" ]; then
		echo 'wrtmesh: refusing a symlinked runtime lock directory' >&2
		restore_service
		exit 1
	fi
	[ -d "$$state" ] || continue
	count=$$((count + 1))
	if [ "$$count" -gt 64 ]; then
		echo 'wrtmesh: too many stale runtime directories' >&2
		restore_service
		exit 1
	fi
	if [ -L "$$state" ] || [ -L "$$state/lock" ]; then
		echo 'wrtmesh: refusing a symlinked runtime lock' >&2
		restore_service
		exit 1
	fi
	[ -f "$$state/lock" ] || continue
	attempt=0
	# C7 BusyBox flock has -n but no -w; dependencies may not yet be upgraded.
	while ! (flock -n 9) 9>"$$state/lock"; do
		attempt=$$((attempt + 1))
		if [ "$$attempt" -ge 20 ]; then
			echo 'wrtmesh: old workers have not released their locks' >&2
			restore_service
			exit 1
		fi
		sleep 1
	done
done
# Snapshot predecessor conffiles before APK removes the old package payload.
# The installed migration helper performs the rename after the new files exist.
archive=/etc/wrtmesh/migration
for dir in /etc/wrtmesh "$$archive"; do
	[ ! -L "$$dir" ] || { restore_service; exit 1; }
	mkdir -p "$$dir" && chmod 700 "$$dir" || { restore_service; exit 1; }
done
[ ! -L "$$archive/complete" ] || { restore_service; exit 1; }
if [ ! -e "$$archive/complete" ]; then
	for pair in xr_roaming:roaming xr_mesh:peers; do
		old=$${pair%:*}; name=$${pair#*:}
		for suffix in '' .apk-save; do
			source=/etc/config/$$old$$suffix
			target=$$archive/$$name$$suffix.uci
			for file in "$$source" "$$target" "$$target.next"; do
				[ ! -L "$$file" ] && { [ ! -e "$$file" ] || { [ -f "$$file" ] && [ "$$(wc -c < "$$file")" -le 65536 ]; }; } || { restore_service; exit 1; }
			done
			[ -f "$$source" ] || continue
			if [ -f "$$target" ]; then
				cmp -s "$$source" "$$target" || { restore_service; exit 1; }
			else
				(umask 077; cp "$$source" "$$target.next" && chmod 600 "$$target.next" && mv "$$target.next" "$$target") || { restore_service; exit 1; }
			fi
		done
	done
fi
exit 0
endef

define Package/wrtmesh/postinst
#!/bin/sh
[ -z "$${IPKG_INSTROOT}" ] || exit 0
[ "$${IPKG_NO_SCRIPT}" = 1 ] && exit 0
/usr/lib/wrtmesh/migrate-config.sh || exit 1
# Reload the ucode plugin and ACL on a running LuCI installation.
if [ -x /etc/init.d/rpcd ]; then
	/etc/init.d/rpcd reload >/dev/null 2>&1 || true
fi
exit 0
endef

define Package/wrtmesh/postrm
#!/bin/sh
[ -z "$${IPKG_INSTROOT}" ] || exit 0
[ "$${IPKG_NO_SCRIPT}" = 1 ] && exit 0
if [ -x /etc/init.d/rpcd ]; then
	/etc/init.d/rpcd reload >/dev/null 2>&1 || true
fi
exit 0
endef

define Package/wrtmesh/install
	$(INSTALL_DIR) $(1)/etc/config $(1)/etc/init.d
	$(INSTALL_CONF) ./files/wrtmesh.config $(1)/etc/config/wrtmesh
	$(INSTALL_CONF) ./files/wrtmesh_peers.config $(1)/etc/config/wrtmesh_peers
	$(INSTALL_BIN) ./files/wrtmesh.init $(1)/etc/init.d/wrtmesh
	$(INSTALL_DIR) $(1)/usr/lib/wrtmesh
	$(INSTALL_BIN) ./files/helper.sh ./files/mesh-daemon.sh ./files/migrate-config.sh $(1)/usr/lib/wrtmesh/
	$(INSTALL_DATA) ./files/common.jq ./files/cli-report.jq ./files/mesh.uc ./files/mesh-sample.uc $(1)/usr/lib/wrtmesh/
	$(INSTALL_DIR) $(1)/usr/share/rpcd/ucode $(1)/usr/share/rpcd/acl.d $(1)/usr/share/luci/menu.d
	$(INSTALL_DATA) ./files/wrtmesh.uc $(1)/usr/share/rpcd/ucode/wrtmesh.uc
	$(INSTALL_DATA) ./files/wrtmesh-acl.json $(1)/usr/share/rpcd/acl.d/wrtmesh.json
	$(INSTALL_DATA) ./files/wrtmesh-menu.json $(1)/usr/share/luci/menu.d/wrtmesh.json
	$(INSTALL_DIR) $(1)/www/cgi-bin $(1)/www/luci-static/resources/view/network
	$(INSTALL_BIN) ./files/wrtmesh.cgi $(1)/www/cgi-bin/wrtmesh
	$(LN) wrtmesh $(1)/www/cgi-bin/xr-mesh
	$(INSTALL_DATA) ./files/wrtmesh.js $(1)/www/luci-static/resources/wrtmesh.js
	$(INSTALL_DATA) ./files/wrtmesh.css $(1)/www/luci-static/resources/wrtmesh.css
	$(INSTALL_DATA) ./files/wrtmesh-view.js $(1)/www/luci-static/resources/view/network/wrtmesh.js
	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/status/include
	$(INSTALL_DATA) ./files/65_wrtmesh.js $(1)/www/luci-static/resources/view/status/include/
	$(INSTALL_DIR) $(1)/usr/lib/lua/luci/i18n
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/wrtmesh.zh-cn.lmo $(1)/usr/lib/lua/luci/i18n/
	$(INSTALL_DIR) $(1)/www
	$(LN) /tmp/wrtmesh-public $(1)/www/wrtmesh
	# Read-only HTTP v1 aliases for existing peer nodes; no old local API names.
	$(LN) /tmp/wrtmesh-public $(1)/www/xr-roaming
endef

$(eval $(call BuildPackage,wrtmesh))
