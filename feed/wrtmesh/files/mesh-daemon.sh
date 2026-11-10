#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-only
set -eu
umask 077
base=/tmp/xr-roaming-private
state=$base/mesh
for dir in "$base" "$state"; do
	[ ! -L "$dir" ] || exit 1
	mkdir -p "$dir"
	[ "$(ls -nd "$dir" | awk '{print $3}')" = 0 ] || exit 1
	chmod 700 "$dir"
done
[ ! -L "$state/lock" ] || exit 1
exec 9>"$state/lock"
flock -n 9 || exit 1
child=
trap 'if [ -n "$child" ]; then kill "$child" 2>/dev/null || :; wait "$child" || :; fi; exit 0' INT TERM
trap 'rm -f "$state/local.json" "$state/peers.json"' EXIT
while :; do
	read -r tick rest < /proc/uptime
	/usr/bin/timeout -k 2 50 /usr/bin/ucode /usr/lib/xr-roaming/mesh-sample.uc &
	child=$!
	wait "$child" || :
	child=
	read -r now rest < /proc/uptime
	wait_for=$((30 - ${now%%.*} + ${tick%%.*}))
	[ "$wait_for" -ge 1 ] || wait_for=1
	sleep "$wait_for" 9>&- &
	child=$!
	wait "$child" || :
	child=
done
