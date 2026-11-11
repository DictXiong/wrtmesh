#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-only
"""Build the noarch wrtmesh package with a checksum-pinned official OpenWrt SDK."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
PIN = json.loads((ROOT / 'ci/openwrt-sdk.json').read_text())


def run(argv, **kwargs):
    print('+ ' + ' '.join(map(str, argv)), flush=True)
    return subprocess.run(list(map(str, argv)), check=True, **kwargs)


def sha(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def version():
    value = (ROOT / 'VERSION').read_text().strip()
    if not re.fullmatch(r'\d+\.\d+\.\d+', value):
        raise ValueError('invalid release version')
    tag = os.environ.get('GITHUB_REF', '')
    if tag.startswith('refs/tags/') and tag != 'refs/tags/v' + value:
        raise ValueError('tag does not match VERSION')
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--archive', type=Path, help='Previously downloaded, still checksum-verified SDK')
    parser.add_argument('--jobs', type=int, default=2)
    args = parser.parse_args()
    release = version()
    work, output = args.work.resolve(), args.output.resolve()
    if work.exists() or output.exists():
        parser.error('work and output must be new directories')
    if args.jobs < 1:
        parser.error('jobs must be positive')
    work.mkdir(parents=True, mode=0o700)
    archive = args.archive.resolve() if args.archive else work / 'sdk.tar.zst'
    if not args.archive:
        run(['curl', '--fail', '--location', '--retry', '3', '--output', archive, PIN['url']])
    if sha(archive) != PIN['sha256']:
        raise RuntimeError('official SDK checksum mismatch')
    sdk = work / 'sdk'
    sdk.mkdir()
    run(['tar', '--zstd', '-xf', archive, '-C', sdk, '--strip-components=1'])
    (sdk / 'feeds.conf').write_text('src-git --root=package base ' + PIN['base_feed'] + '\n'
                                   'src-git packages ' + PIN['packages_feed'] + '\n'
                                   'src-git luci ' + PIN['luci_feed'] + '\n'
                                   'src-link wrtmesh ' + str(ROOT) + '\n')
    run(['./scripts/feeds', 'update', 'base', 'packages', 'luci', 'wrtmesh'], cwd=sdk)
    run(['./scripts/feeds', 'install', 'wrtmesh'], cwd=sdk)
    # SDK defaults enable ALL packages, including every hostapd/TLS variant.
    # Start a minimal config; the SDK supplies its fixed target/toolchain.
    (sdk / '.config').write_text(
        '# CONFIG_ALL is not set\n# CONFIG_ALL_NONSHARED is not set\n'
        '# CONFIG_ALL_KMODS is not set\nCONFIG_PACKAGE_wrtmesh=m\n'
        'CONFIG_PACKAGE_wpad-basic-mbedtls=m\nCONFIG_SIGNED_PACKAGES=y\n')
    run(['make', 'defconfig'], cwd=sdk)
    # Each build has its own signing identity. Only its public key is exported;
    # release provenance authenticates both the package and that exact key.
    key = sdk / 'private-key.pem'
    with key.open('wb') as stream:
        os.chmod(key, 0o600)
        run(['openssl', 'ecparam', '-name', 'prime256v1', '-genkey', '-noout'], stdout=stream)
    with (sdk / 'public-key.pem').open('wb') as stream:
        run(['openssl', 'pkey', '-in', key, '-pubout'], stdout=stream)
    try:
        run(['make', '-j' + str(args.jobs), 'package/wrtmesh/compile', 'V=s'], cwd=sdk)
        packages = list((sdk / 'bin').rglob('wrtmesh-*.apk'))
        if len(packages) != 1:
            raise RuntimeError('expected exactly one SDK-built APK')
        apk = sdk / 'staging_dir/host/bin/apk'
        # 25.12.0's SDK signs repository indexes, not individual APKs. Sign
        # our own freshly built artifact explicitly, then verify it when
        # indexing below. This flag never reaches installation on the target.
        run([apk, 'adbsign', '--allow-untrusted', '--sign', key, packages[0]])
        dumped = subprocess.check_output([str(apk), 'adbdump', str(packages[0])], text=True)
        if not re.search(r'\barch:\s*noarch\b', dumped):
            raise RuntimeError('SDK artifact must actually declare noarch')
        output.mkdir(parents=True)
        package = output / packages[0].name
        shutil.copyfile(packages[0], package)
        public = output / ('wrtmesh-v' + release + '.pem')
        shutil.copyfile(sdk / 'public-key.pem', public)
        run([apk, 'mkndx', '--keys-dir', sdk, '--sign', key, '--output', output / 'packages.adb', package])
    finally:
        key.unlink(missing_ok=True)
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    package_version = release + '-r1'
    metadata = {
        'schema_version': 1, 'version': release, 'package_version': package_version,
        'source_revision': revision, 'openwrt_release': PIN['release'],
        'sdk': PIN, 'architecture': 'noarch', 'package': package.name,
        'package_sha256': sha(package), 'signing_key': public.name,
        'compatibility': 'APK 3. Roaming requires a supported hostapd interface. LuCI Mesh and Overview modules are owned by the package.',
    }
    (output / 'release.json').write_text(json.dumps(metadata, indent=2) + '\n')
    (output / 'SHA256SUMS').write_text(''.join(sha(p) + '  ' + p.name + '\n'
        for p in sorted(output.iterdir()) if p.is_file()))
    print(json.dumps(metadata, indent=2), flush=True)


if __name__ == '__main__':
    main()
