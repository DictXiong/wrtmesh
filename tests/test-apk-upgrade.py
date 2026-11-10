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


def test(apk, apk_builder, new, old):
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
        local_index = stage / 'packages.adb'
        dependency_paths = []
        for name in sorted(dependencies(apk, old) | dependencies(apk, new)):
            path = stage / (name + '-1-r0.apk')
            mkpkg(apk_builder, path, name, '1-r0')
            dependency_paths.append(path)
        run(apk_builder, '--allow-untrusted', 'mkndx', '--output', local_index, old, *dependency_paths)
        for kind in ('named', 'local-apk'):
            root = stage / kind
            root.mkdir()
            args = ['--root', root, '--arch', 'aarch64_cortex-a53', '--no-network',
                    '--allow-untrusted', '--repository', local_index]
            try:
                run(apk, *args, 'add', '--no-scripts', '--initdb', old if kind == 'local-apk' else 'xr-roaming')
                (root / 'etc/config/xr_roaming').write_bytes(ROAMING)
                (root / 'etc/config/xr_mesh').write_bytes(MESH)
                if kind == 'local-apk':
                    run(apk, *args, 'add', '--no-scripts', new, 'xr-roaming')
                else:
                    run(apk, *args, 'add', '--no-scripts', new)
                installed = run(apk, *args, 'info').splitlines()
            except subprocess.CalledProcessError as exc:
                raise RuntimeError(exc.output) from exc
            assert 'wrtmesh' in installed and 'xr-roaming' not in installed, installed
            assert (root / 'etc/config/xr_roaming').read_bytes() == ROAMING
            assert (root / 'etc/config/xr_mesh').read_bytes() == MESH
            assert (root / 'etc/init.d/xr_roaming').is_file()
            assert (root / 'www/luci-static/resources/xrmesh.css').stat().st_size > 0
            assert (root / 'usr/lib/lua/luci/i18n/wrtmesh.zh-cn.lmo').stat().st_size > 0
            assert (root / 'www/xr-roaming').readlink() == Path('/tmp/xr-roaming-public')
            hashes = root / 'lib/apk/packages/wrtmesh.conffiles_static'
            assert {line.split()[0] for line in hashes.read_text().splitlines()} == {
                '/etc/config/xr_roaming', '/etc/config/xr_mesh',
            }
            assert not (root / 'lib/apk/packages/xr-roaming.conffiles_static').exists()
            print(kind + ': old package replaced and both settings files preserved')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apk', required=True, help='APK command (may be prefixed by QEMU)')
    parser.add_argument('--apk-builder', help='Host APK with mkpkg when --apk is an OpenWrt target')
    parser.add_argument('--package', type=Path, required=True)
    parser.add_argument('--old-package', type=Path)
    args = parser.parse_args()
    test(shlex.split(args.apk), shlex.split(args.apk_builder or args.apk),
         args.package.resolve(), args.old_package.resolve() if args.old_package else None)


if __name__ == '__main__':
    main()
