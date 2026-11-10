# SPDX-License-Identifier: GPL-2.0-only

WRTMESH_SOURCE_DIR:=$(abspath $(dir $(realpath $(lastword $(MAKEFILE_LIST))))/../..)
include $(TOPDIR)/rules.mk

PKG_NAME:=wrtmesh
PKG_VERSION:=$(strip $(shell cat $(WRTMESH_SOURCE_DIR)/VERSION))
PKG_RELEASE:=1
PKG_LICENSE:=GPL-2.0-only

include $(INCLUDE_DIR)/package.mk

define Package/wrtmesh
  PKGARCH:=all
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=WirelessAPD
  TITLE:=XR1710G roaming assistance and mesh visibility
  URL:=https://github.com/DictXiong/wrtmesh
  PROVIDES:=xr-roaming
  DEPENDS:=+hostapd-utils +jq +curl +coreutils-timeout +flock +uci +ubus +uhttpd
  DEPENDS+=+umdns +ucode-mod-fs +ucode-mod-ubus +ucode-mod-uci +ucode-mod-rtnl +rpcd-mod-ucode +luci-mod-network
endef

define Package/wrtmesh/description
  Multi-AP peer discovery, station and topology visibility, and wired-backhaul
  roaming assistance for supported XR1710G C7 hostapd builds.
endef

define Package/wrtmesh/conffiles
/etc/config/xr_roaming
/etc/config/xr_mesh
endef

define Build/Prepare
endef

define Build/Configure
endef

define Build/Compile
endef

define Package/wrtmesh/preinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] && exit 0
[ "$${IPKG_NO_SCRIPT}" = 1 ] && exit 0
restore_service() {
	[ ! -x /etc/init.d/xr_roaming ] || /etc/init.d/xr_roaming start >/dev/null 2>&1 || true
}
if [ -x /etc/init.d/xr_roaming ]; then
	/etc/init.d/xr_roaming stop || exit 1
fi
# An old shell must not continue running while its jq modules are replaced.
# A package-name transition may already have removed the old init script.
base=/tmp/xr-roaming-private
[ ! -L "$$base" ] || exit 1
count=0
# The main lock and every old/new profile lock live at depth zero or one.
# Do not infer the old worker set from the newly supplied UCI configuration.
for state in "$$base" "$$base"/*; do
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
exit 0
endef

define Package/wrtmesh/postinst
#!/bin/sh
[ -z "$${IPKG_INSTROOT}" ] || exit 0
[ "$${IPKG_NO_SCRIPT}" = 1 ] && exit 0
# Reload the ucode plugin and ACL on a running LuCI installation.
if [ -x /etc/init.d/rpcd ]; then
	/etc/init.d/rpcd reload >/dev/null 2>&1 || true
fi
exit 0
endef

define Package/wrtmesh/install
	$(INSTALL_DIR) $(1)/etc/config $(1)/etc/init.d
	$(INSTALL_CONF) ./files/xr_roaming.config $(1)/etc/config/xr_roaming
	$(INSTALL_CONF) ./files/xr_mesh.config $(1)/etc/config/xr_mesh
	$(INSTALL_BIN) ./files/xr_roaming.init $(1)/etc/init.d/xr_roaming
	$(INSTALL_DIR) $(1)/usr/lib/xr-roaming
	$(INSTALL_BIN) ./files/helper.sh ./files/mesh-daemon.sh $(1)/usr/lib/xr-roaming/
	$(INSTALL_DATA) ./files/common.jq ./files/cli-report.jq ./files/mesh.uc ./files/mesh-sample.uc $(1)/usr/lib/xr-roaming/
	$(INSTALL_DIR) $(1)/usr/share/rpcd/ucode $(1)/usr/share/rpcd/acl.d $(1)/usr/share/luci/menu.d
	$(INSTALL_DATA) ./files/xrmesh.uc $(1)/usr/share/rpcd/ucode/xrmesh.uc
	$(INSTALL_DATA) ./files/xrmesh-acl.json $(1)/usr/share/rpcd/acl.d/xrmesh.json
	$(INSTALL_DATA) ./files/xrmesh-menu.json $(1)/usr/share/luci/menu.d/xrmesh.json
	$(INSTALL_DIR) $(1)/www/cgi-bin $(1)/www/luci-static/resources/view/network
	$(INSTALL_BIN) ./files/xr-mesh.cgi $(1)/www/cgi-bin/xr-mesh
	$(INSTALL_DATA) ./files/xrmesh.js $(1)/www/luci-static/resources/xrmesh.js
	$(INSTALL_DATA) ./files/xrmesh-view.js $(1)/www/luci-static/resources/view/network/xrmesh.js
	$(INSTALL_DIR) $(1)/www
	$(LN) /tmp/xr-roaming-public $(1)/www/xr-roaming
endef

$(eval $(call BuildPackage,wrtmesh))
