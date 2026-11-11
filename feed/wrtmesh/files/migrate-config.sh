#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-only
# Local, one-time migration. No configuration received from a peer is applied.
set -eu
umask 077
prefix=${1:-}
case "$prefix" in ''|/*) :;; *) exit 1;; esac
config=$prefix/etc/config
archive=$prefix/etc/wrtmesh/migration
lock=$prefix/tmp/wrtmesh-migrate.lock
for dir in "$prefix/etc" "$config" "$prefix/etc/wrtmesh" "$archive" "$prefix/tmp"; do
 [ ! -L "$dir" ] || exit 1
 mkdir -p "$dir"
done
chmod 700 "$prefix/etc/wrtmesh" "$archive"
[ ! -L "$lock" ] || exit 1
exec 9>"$lock"
flock -n 9 || exit 1
[ ! -L "$archive/complete" ] || exit 1
[ ! -f "$archive/complete" ] || exit 0

meaningful() {
 [ -f "$1" ] && awk 'NF && $1 !~ /^#/ { found=1 } END { exit !found }' "$1"
}
safe_file() {
 [ ! -L "$1" ] && { [ ! -e "$1" ] || { [ -f "$1" ] && [ "$(wc -c < "$1")" -le 65536 ]; }; }
}
snapshot() {
 local source=$1 target=$2
 safe_file "$source" && safe_file "$target" || return 1
 [ -f "$source" ] || return 0
 if [ -f "$target" ]; then
  cmp -s "$source" "$target" || {
   echo 'wrtmesh: conflicting legacy configuration backup; migration stopped' >&2
   return 1
  }
 else
  safe_file "$target.next" || return 1
  cp "$source" "$target.next" && chmod 600 "$target.next" && mv "$target.next" "$target" || return 1
 fi
}
for item in roaming peers; do
 case "$item" in roaming) old=xr_roaming; new=wrtmesh;; peers) old=xr_mesh; new=wrtmesh_peers;; esac
 safe_file "$config/$new" || exit 1
 safe_file "$config/$new.wrtmesh-migrate" || exit 1
 rm -f "$config/$new.wrtmesh-migrate"
 snapshot "$config/$old" "$archive/$item.uci"
 snapshot "$config/$old.apk-save" "$archive/$item.apk-save.uci"
 source=$archive/$item.uci
 # APK may keep a modified predecessor conffile only as .apk-save.
 if ! meaningful "$source" && meaningful "$archive/$item.apk-save.uci"; then
  source=$archive/$item.apk-save.uci
 fi
 if [ -f "$source" ] && ! meaningful "$config/$new"; then
  target=$config/$new.wrtmesh-migrate
  cp "$source" "$target" && chmod 600 "$target"
 fi
done
# Stage both copies before replacing either; a partial rename is retryable.
for new in wrtmesh wrtmesh_peers; do
 target=$config/$new.wrtmesh-migrate
 [ ! -f "$target" ] || mv "$target" "$config/$new"
done
for item in roaming peers; do
 case "$item" in roaming) old=xr_roaming;; peers) old=xr_mesh;; esac
 for suffix in '' .apk-save; do
  source=$config/$old$suffix
  backup=$archive/$item$suffix.uci
  if [ -f "$source" ] && [ ! -L "$source" ] && cmp -s "$source" "$backup"; then
   rm "$source"
  fi
 done
done
printf '%s\n' 1 > "$archive/complete"
