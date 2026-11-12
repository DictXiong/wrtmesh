#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-only
"""Test APK ownership and historical configuration migration in isolated roots.

APK scripts are disabled because a host APK root is not a running OpenWrt
system. Run the current preinstall snapshot with isolated paths, then invoke
the migration helper installed by the actual candidate APK.
"""
import argparse
import hashlib
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tempfile


ROAMING = b"""# Keep formatting and local settings exactly.
config roaming 'main'
	option enabled '1'
	option peer '192.168.50.2'
"""
MESH = b"""config peer 'p_020000000002'
	option bridge_mac '02:00:00:00:00:02'
	option address '192.168.50.2'
"""
CANONICAL_ROAMING = b"config roaming 'office'\n\toption enabled '0'\n"
CANONICAL_PEERS = b"# Deliberately keep the new local peer policy.\nconfig peer 'manual'\n"
INCLUDE = Path('www/luci-static/resources/view/status/include')
STOCK = b"/* Standard LuCI wireless include fixture */\n"
OTHER = b"/* Another package's Overview include fixture */\n"
OWNED_UI = (
    INCLUDE / '65_wrtmesh.js',
    Path('www/luci-static/resources/wrtmesh.css'),
    Path('www/luci-static/resources/wrtmesh.js'),
    Path('www/luci-static/resources/view/network/wrtmesh.js'),
    Path('usr/lib/lua/luci/i18n/wrtmesh.zh-cn.lmo'),
    Path('usr/share/luci/menu.d/wrtmesh.json'),
    Path('usr/share/rpcd/acl.d/wrtmesh.json'),
    Path('usr/share/rpcd/ucode/wrtmesh.uc'),
)
LEGACY_UI = (
    Path('www/luci-static/resources/xrmesh.js'),
    Path('www/luci-static/resources/xrmesh.css'),
    Path('www/luci-static/resources/view/network/xrmesh.js'),
    Path('usr/share/luci/menu.d/xrmesh.json'),
    Path('usr/share/rpcd/acl.d/xrmesh.json'),
    Path('usr/share/rpcd/ucode/xrmesh.uc'),
)
ALIASES = {
    Path('www/wrtmesh'): Path('/tmp/wrtmesh-public'),
    Path('www/xr-roaming'): Path('/tmp/wrtmesh-public'),
    Path('www/cgi-bin/xr-mesh'): Path('wrtmesh'),
}


def run(apk, *args):
    return subprocess.check_output([*apk, *map(str, args)], text=True, stderr=subprocess.STDOUT)


def dependencies(apk, package):
    dump = run(apk, 'adbdump', package)
    match = re.search(r'^  depends:.*\n((?:    - .*\n)+)', dump, re.M)
    if not match:
        return set()
    values = set(match[1].replace('    - ', '').splitlines())
    if not all(re.fullmatch(r'[\w.+-]+', name) for name in values):
        raise ValueError('unexpected versioned or complex dependency in migration fixture')
    return values


def mkpkg(apk, path, name, version, payload=None):
    args = ['mkpkg', '--info', 'name:' + name, '--info', 'version:' + version,
            '--info', 'arch:noarch', '--output', path]
    if payload:
        args += ['--files', payload]
    run(apk, *args)


def write(root, relative, value, mode=0o644):
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(value)
    path.chmod(mode)
    return path


def historical_package(apk, stage, name, version, overview=False):
    """Model the actual predecessor names, not the candidate's new names."""
    payload = stage / (name + '-' + version)
    write(payload, 'etc/config/xr_roaming', b'# Historical roaming defaults\n', 0o600)
    configs = ['etc/config/xr_roaming']
    if name == 'wrtmesh':
        write(payload, 'etc/config/xr_mesh', b'# Historical peer defaults\n', 0o600)
        configs.append('etc/config/xr_mesh')
        for relative in LEGACY_UI:
            write(payload, relative, b'/* Historical Mesh asset fixture */\n')
    if overview:
        write(payload, INCLUDE / '65_wrtmesh.js', b'/* Historical package-owned Mesh include */\n')
    write(payload, 'etc/init.d/xr_roaming', b'#!/bin/sh\nexit 0\n', 0o755)
    write(payload, 'usr/lib/xr-roaming/helper.sh', b'#!/bin/sh\nexit 0\n', 0o755)
    hashes = ''.join('/' + path + ' ' + hashlib.sha256((payload / path).read_bytes()).hexdigest() + '\n'
                     for path in configs)
    write(payload, f'lib/apk/packages/{name}.conffiles_static', hashes.encode())
    package = stage / (name + '-' + version + '.apk')
    mkpkg(apk, package, name, version, payload)
    return package


def canonical_package(apk, stage):
    payload = stage / 'canonical-previous'
    configs = ['etc/config/wrtmesh', 'etc/config/wrtmesh_peers']
    for relative in configs:
        write(payload, relative, b'# Previous canonical defaults\n', 0o600)
    for relative in OWNED_UI:
        write(payload, relative, b'/* Previous package-owned UI fixture */\n')
    write(payload, 'etc/init.d/wrtmesh', b'#!/bin/sh\nexit 0\n', 0o755)
    hashes = ''.join('/' + path + ' ' + hashlib.sha256((payload / path).read_bytes()).hexdigest() + '\n'
                     for path in configs)
    write(payload, 'lib/apk/packages/wrtmesh.conffiles_static', hashes.encode())
    package = stage / 'wrtmesh-6.3.0-r1.apk'
    mkpkg(apk, package, 'wrtmesh', '6.3.0-r1', payload)
    return package


def snapshot_preinstall(root, makefile):
    script = re.search(r'^define Package/wrtmesh/preinst\n(.*?)^endef$', makefile, re.M | re.S)[1]
    script = script.replace('$$', '$')
    # One substitution pass prevents rewriting /tmp inside the fixture prefix.
    script = re.sub(r'(?<![A-Za-z0-9_./-])/(?:etc|tmp)(?=/|\b)',
                    lambda match: str(root) + match[0], script)
    for name in ('wrtmesh', 'xr_roaming'):
        if (root / 'etc/init.d' / name).exists():
            write(root, 'etc/init.d/' + name, b'#!/bin/sh\nexit 0\n', 0o755)
    (root / 'tmp').mkdir(exist_ok=True)
    env = {key: value for key, value in os.environ.items()
           if key not in {'IPKG_INSTROOT', 'IPKG_NO_SCRIPT'}}
    result = subprocess.run(['sh', '-s'], input=script, text=True, capture_output=True,
                            env=env, timeout=10)
    assert result.returncode == 0, result.stderr


def migrate(root):
    result = subprocess.run(['sh', str(root / 'usr/lib/wrtmesh/migrate-config.sh'), str(root)],
                            text=True, capture_output=True, timeout=10)
    assert result.returncode == 0, result.stderr


def test(apk, apk_builder, new, old, previous):
    makefile = (Path(__file__).resolve().parents[1] / 'feed/wrtmesh/Makefile').read_text()
    with tempfile.TemporaryDirectory(prefix='wrtmesh-apk-upgrade-') as tmp:
        stage = Path(tmp)
        legacy = (Path(shutil.copyfile(old, stage / old.name)) if old else
                  historical_package(apk_builder, stage, 'xr-roaming', '6.0.0-r2'))
        previous61 = historical_package(apk_builder, stage, 'wrtmesh', '6.1.0-r2')
        previous62 = historical_package(apk_builder, stage, 'wrtmesh', '6.2.0-r1', overview=True)
        previous63 = canonical_package(apk_builder, stage)
        canonical_upgrade = 'upgrade-6.3'
        if previous:
            supplied = Path(shutil.copyfile(previous, stage / ('supplied-' + previous.name)))
            version = re.search(r'^  version: (.+)$', run(apk, 'adbdump', supplied), re.M)[1]
            if version.startswith('6.1.'):
                previous61 = supplied
            elif version.startswith('6.2.'):
                previous62 = supplied
            elif version.startswith(('6.3.', '6.4.')):
                previous63 = supplied
                canonical_upgrade = 'upgrade-' + '.'.join(version.split('.')[:2])
            else:
                raise ValueError('--previous-package must be a wrtmesh 6.1, 6.2, 6.3 or 6.4 package')
        dependency_paths = []
        names = set().union(*(dependencies(apk, package) for package in (legacy, previous61, previous62, previous63, new)))
        for name in sorted(names | {'luci-mod-status'}):
            path = stage / (name + '-1-r0.apk')
            payload = None
            if name == 'luci-mod-status':
                payload = stage / 'stock'
                write(payload, INCLUDE / '60_wifi.js', STOCK)
                write(payload, INCLUDE / '66_other.js', OTHER)
            mkpkg(apk_builder, path, name, '1-r0', payload)
            dependency_paths.append(path)
        local_index = stage / 'packages.adb'
        run(apk_builder, '--allow-untrusted', 'mkndx', '--output', local_index, legacy, *dependency_paths)
        scenarios = (
            ('fresh', None, False),
            ('named-legacy', 'xr-roaming', False),
            ('local-legacy', legacy, False),
            ('upgrade-6.1', previous61, False),
            ('upgrade-6.2', previous62, False),
            (canonical_upgrade, previous63, True),
            ('canonical-wins', previous62, True),
        )
        for kind, baseline, canonical in scenarios:
            root = stage / kind
            root.mkdir()
            args = ['--root', root, '--arch', 'aarch64_cortex-a53', '--no-network',
                    '--allow-untrusted', '--repository', local_index]
            try:
                initial = [baseline] if baseline is not None else []
                run(apk, *args, 'add', '--no-scripts', '--initdb', 'luci-mod-status', *initial)
                stock = root / INCLUDE / '60_wifi.js'
                other = root / INCLUDE / '66_other.js'
                assert stock.read_bytes() == STOCK and other.read_bytes() == OTHER
                if baseline is not None and kind != canonical_upgrade:
                    write(root, 'etc/config/xr_roaming', ROAMING, 0o600)
                    write(root, 'etc/config/xr_mesh', MESH, 0o600)
                if kind == canonical_upgrade:
                    # Model a completed earlier migration and later canonical
                    # edits; an upgrade must never restore the archived data.
                    write(root, 'etc/wrtmesh/migration/roaming.uci', ROAMING, 0o600)
                    write(root, 'etc/wrtmesh/migration/peers.uci', MESH, 0o600)
                    write(root, 'etc/wrtmesh/migration/complete', b'1\n', 0o600)
                if canonical:
                    write(root, 'etc/config/wrtmesh', CANONICAL_ROAMING, 0o600)
                    write(root, 'etc/config/wrtmesh_peers', CANONICAL_PEERS, 0o600)
                snapshot_preinstall(root, makefile)
                archive = root / 'etc/wrtmesh/migration'
                if baseline is not None:
                    assert (archive / 'roaming.uci').read_bytes() == ROAMING
                    assert (archive / 'peers.uci').read_bytes() == MESH
                extra = ['xr-roaming'] if kind == 'local-legacy' else []
                run(apk, *args, 'add', '--no-scripts', new, *extra)
                migrate(root)
                installed = run(apk, *args, 'info').splitlines()
                assert 'wrtmesh' in installed and 'xr-roaming' not in installed, installed
                if baseline is not None:
                    assert (root / 'etc/config/wrtmesh').read_bytes() == (CANONICAL_ROAMING if canonical else ROAMING)
                    assert (root / 'etc/config/wrtmesh_peers').read_bytes() == (CANONICAL_PEERS if canonical else MESH)
                    assert (archive / 'roaming.uci').read_bytes() == ROAMING
                    assert (archive / 'peers.uci').read_bytes() == MESH
                    assert (archive / 'roaming.uci').stat().st_mode & 0o777 == 0o600
                    assert not (root / 'etc/config/xr_roaming').exists()
                    assert not (root / 'etc/config/xr_mesh').exists()
                before = [(root / 'etc/config' / name).read_bytes() for name in ('wrtmesh', 'wrtmesh_peers')]
                migrate(root)
                assert before == [(root / 'etc/config' / name).read_bytes() for name in ('wrtmesh', 'wrtmesh_peers')]
                assert (root / 'etc/init.d/wrtmesh').is_file()
                for entry in OWNED_UI:
                    assert (root / entry).stat().st_size > 0, entry
                assert all(not (root / entry).exists() for entry in LEGACY_UI)
                assert stock.read_bytes() == STOCK and other.read_bytes() == OTHER
                for path, target in ALIASES.items():
                    assert (root / path).is_symlink() and (root / path).readlink() == target, path
                hashes = root / 'lib/apk/packages/wrtmesh.conffiles_static'
                assert {line.split()[0] for line in hashes.read_text().splitlines()} == {
                    '/etc/config/wrtmesh', '/etc/config/wrtmesh_peers',
                }
                assert not (root / 'lib/apk/packages/xr-roaming.conffiles_static').exists()
                run(apk, *args, 'del', '--no-scripts', 'wrtmesh', 'xr-roaming')
                installed = run(apk, *args, 'info').splitlines()
            except subprocess.CalledProcessError as exc:
                raise RuntimeError(exc.output) from exc
            assert 'wrtmesh' not in installed and 'luci-mod-status' in installed
            for entry in (*OWNED_UI, *ALIASES):
                assert not (root / entry).exists() and not (root / entry).is_symlink(), entry
            assert stock.read_bytes() == STOCK and other.read_bytes() == OTHER
            if baseline is not None:
                assert (archive / 'roaming.uci').read_bytes() == ROAMING
                assert (archive / 'peers.uci').read_bytes() == MESH
            print(kind + ': historical sources migrated; package UI removed; stock Overview preserved')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apk', required=True, help='APK command (may be prefixed by QEMU)')
    parser.add_argument('--apk-builder', help='Host APK with mkpkg when --apk is an OpenWrt target')
    parser.add_argument('--package', type=Path, required=True)
    parser.add_argument('--old-package', type=Path, help='an xr-roaming 6.0 package')
    parser.add_argument('--previous-package', type=Path, help='a wrtmesh 6.1/6.2 historical-path or 6.3/6.4 canonical-path package')
    args = parser.parse_args()
    test(shlex.split(args.apk), shlex.split(args.apk_builder or args.apk),
         args.package.resolve(), args.old_package.resolve() if args.old_package else None,
         args.previous_package.resolve() if args.previous_package else None)


if __name__ == '__main__':
    main()
