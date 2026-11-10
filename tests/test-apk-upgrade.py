#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-only
"""Test the real APK solver and conffile preservation in isolated roots."""
import argparse
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
INCLUDE = Path('www/luci-static/resources/view/status/include')
STOCK = b"/* Standard LuCI wireless include fixture */\n"
OWNED_UI = (
    INCLUDE / '65_wrtmesh.js',
    Path('www/luci-static/resources/xrmesh.css'),
    Path('www/luci-static/resources/xrmesh.js'),
    Path('www/luci-static/resources/view/network/xrmesh.js'),
    Path('usr/lib/lua/luci/i18n/wrtmesh.zh-cn.lmo'),
    Path('usr/share/luci/menu.d/xrmesh.json'),
    Path('usr/share/rpcd/acl.d/xrmesh.json'),
    Path('usr/share/rpcd/ucode/xrmesh.uc'),
)


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


def test(apk, apk_builder, new, old, previous):
    with tempfile.TemporaryDirectory(prefix='wrtmesh-apk-upgrade-') as tmp:
        stage = Path(tmp)
        if old is None:
            payload = stage / 'legacy'
            (payload / 'etc/config').mkdir(parents=True)
            (payload / 'etc/config/xr_roaming').write_text('# Old defaults\n')
            (payload / 'etc/config/xr_mesh').write_text('# Old Mesh defaults\n')
            old = stage / 'xr-roaming-6.0.0-r2.apk'
            mkpkg(apk_builder, old, 'xr-roaming', '6.0.0-r2', payload)
        else:
            old = Path(shutil.copyfile(old, stage / old.name))
        if previous is None:
            payload = stage / 'previous'
            (payload / 'etc/config').mkdir(parents=True)
            (payload / 'etc/config/xr_roaming').write_text('# Previous defaults\n')
            (payload / 'etc/config/xr_mesh').write_text('# Previous Mesh defaults\n')
            previous = stage / 'wrtmesh-6.1.0-r2.apk'
            mkpkg(apk_builder, previous, 'wrtmesh', '6.1.0-r2', payload)
        local_index = stage / 'packages.adb'
        dependency_paths = []
        for name in sorted(dependencies(apk, old) | dependencies(apk, previous) | dependencies(apk, new)):
            path = stage / (name + '-1-r0.apk')
            payload = None
            if name == 'luci-mod-status':
                payload = stage / 'stock'
                (payload / INCLUDE).mkdir(parents=True)
                (payload / INCLUDE / '60_wifi.js').write_bytes(STOCK)
            mkpkg(apk_builder, path, name, '1-r0', payload)
            dependency_paths.append(path)
        run(apk_builder, '--allow-untrusted', 'mkndx', '--output', local_index, old, *dependency_paths)
        for kind in ('fresh', 'named', 'local-apk', 'upgrade'):
            root = stage / kind
            root.mkdir()
            args = ['--root', root, '--arch', 'aarch64_cortex-a53', '--no-network',
                    '--allow-untrusted', '--repository', local_index]
            try:
                baseline = {'fresh': [], 'local-apk': [old], 'named': ['xr-roaming'], 'upgrade': [previous]}[kind]
                run(apk, *args, 'add', '--no-scripts', '--initdb', 'luci-mod-status', *baseline)
                stock = root / INCLUDE / '60_wifi.js'
                assert stock.read_bytes() == STOCK
                assert not (root / INCLUDE / '65_wrtmesh.js').exists()
                if baseline:
                    (root / 'etc/config').mkdir(exist_ok=True)
                    (root / 'etc/config/xr_roaming').write_bytes(ROAMING)
                    (root / 'etc/config/xr_mesh').write_bytes(MESH)
                run(apk, *args, 'add', '--no-scripts', new, *(['xr-roaming'] if kind == 'local-apk' else []))
                installed = run(apk, *args, 'info').splitlines()
            except subprocess.CalledProcessError as exc:
                raise RuntimeError(exc.output) from exc
            assert 'wrtmesh' in installed and 'xr-roaming' not in installed, installed
            if baseline:
                assert (root / 'etc/config/xr_roaming').read_bytes() == ROAMING
                assert (root / 'etc/config/xr_mesh').read_bytes() == MESH
            assert (root / 'etc/init.d/xr_roaming').is_file()
            for entry in OWNED_UI:
                assert (root / entry).stat().st_size > 0
            assert stock.read_bytes() == STOCK
            assert (root / 'www/xr-roaming').readlink() == Path('/tmp/xr-roaming-public')
            hashes = root / 'lib/apk/packages/wrtmesh.conffiles_static'
            assert {line.split()[0] for line in hashes.read_text().splitlines()} == {
                '/etc/config/xr_roaming', '/etc/config/xr_mesh',
            }
            assert not (root / 'lib/apk/packages/xr-roaming.conffiles_static').exists()
            run(apk, *args, 'del', '--no-scripts', 'wrtmesh', 'xr-roaming')
            installed = run(apk, *args, 'info').splitlines()
            assert 'wrtmesh' not in installed and 'luci-mod-status' in installed
            assert all(not (root / entry).exists() for entry in OWNED_UI)
            assert stock.read_bytes() == STOCK
            print(kind + ': Mesh include installed and removed; stock wireless include preserved')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apk', required=True, help='APK command (may be prefixed by QEMU)')
    parser.add_argument('--apk-builder', help='Host APK with mkpkg when --apk is an OpenWrt target')
    parser.add_argument('--package', type=Path, required=True)
    parser.add_argument('--old-package', type=Path)
    parser.add_argument('--previous-package', type=Path, help='a wrtmesh APK from before the Overview include')
    args = parser.parse_args()
    test(shlex.split(args.apk), shlex.split(args.apk_builder or args.apk),
         args.package.resolve(), args.old_package.resolve() if args.old_package else None,
         args.previous_package.resolve() if args.previous_package else None)


if __name__ == '__main__':
    main()
