#!/usr/bin/env python3
"""Check package lifecycle in inert directories; never operate an AP."""

import argparse
import fcntl
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--installed-root", type=Path,
                        help="also inspect the unpacked/installed APK payload")
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    package = repo / "feed/wrtmesh"
    makefile = (package / "Makefile").read_text()
    package_definition = makefile.split("define Package/wrtmesh\n", 1)[1].split("\nendef", 1)[0]
    dependencies = " ".join(line.strip().split("=", 1)[1]
                            for line in package_definition.splitlines()
                            if line.strip().startswith(("DEPENDS:=", "DEPENDS+=")))
    assert "+rpcd" in dependencies.split(), "select rpcd explicitly to avoid the LuCI dependency cycle"
    assert "+luci-mod-status" in dependencies.split(), "the package requires the Overview include loader"
    preinst = makefile.split("define Package/wrtmesh/preinst\n", 1)[1].split("\nendef", 1)[0]
    preinst = preinst.replace("$$", "$")
    results = []

    def check(name, fn):
        fn()
        results.append({"name": name, "passed": True})

    def hooks():
        with tempfile.TemporaryDirectory(prefix="xr-roaming-package-") as tmp:
            root = Path(tmp)
            state = root / "state"
            state.mkdir()
            service = root / "service"
            calls = root / "calls"
            service.write_text("#!/bin/sh\nprintf '%s\\n' \"$1\" >> " + shlex.quote(str(calls)) + "\n")
            service.chmod(0o700)
            bin_dir = root / "bin"
            bin_dir.mkdir()
            sleep = bin_dir / "sleep"
            # A failed lock still exercises real flock. Do not spend 20 seconds
            # waiting for a deliberately permanent fixture lock.
            sleep.write_text("#!/bin/sh\nexit 0\n")
            sleep.chmod(0o700)
            script = preinst.replace("/etc/init.d/xr_roaming", str(service))
            script = script.replace("/tmp/xr-roaming-private", str(state))
            env = dict(os.environ, PATH=str(bin_dir) + ":" + os.environ["PATH"])
            for name in ["IPKG_INSTROOT", "IPKG_NO_SCRIPT"]:
                env.pop(name, None)

            def run(extra=None):
                return subprocess.run(["sh", "-s"], input=script, text=True,
                                      capture_output=True, env=dict(env, **(extra or {})), timeout=8)

            assert run({"IPKG_INSTROOT": str(root / "image")}).returncode == 0
            assert not calls.exists(), "offline image construction called a service"
            assert run({"IPKG_NO_SCRIPT": "1"}).returncode == 0
            assert not calls.exists(), "no-script installation called a service"
            assert run().returncode == 0
            assert calls.read_text().splitlines() == ["stop"]
            calls.unlink()
            lock = state / "lock"
            with lock.open("w") as held:
                fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
                failed = run()
                assert failed.returncode != 0, "upgrade proceeded with a running old worker"
                assert "not released" in failed.stderr
                assert calls.read_text().splitlines() == ["stop", "start"]
            calls.unlink()
            assert run().returncode == 0
            assert calls.read_text().splitlines() == ["stop"]
            calls.unlink()
            dynamic = state / 'profile-office'
            dynamic.mkdir()
            with (dynamic / 'lock').open('w') as held:
                fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
                failed = run()
                assert failed.returncode != 0, 'upgrade ignored a dynamic profile worker lock'
                assert 'not released' in failed.stderr
                assert calls.read_text().splitlines() == ['stop', 'start']
            calls.unlink()
            assert run().returncode == 0
            assert calls.read_text().splitlines() == ['stop']
            calls.unlink()
            lock.unlink()
            sentinel = root / "unrelated"
            sentinel.write_text("keep me\n")
            lock.symlink_to(sentinel)
            failed = run()
            assert failed.returncode != 0
            assert "symlinked" in failed.stderr
            assert sentinel.read_text() == "keep me\n"
            assert calls.read_text().splitlines() == ["stop", "start"]

    check("offline-and-upgrade-hooks-locks-and-failure-recovery", hooks)

    def rpcd_hooks():
        with tempfile.TemporaryDirectory(prefix="wrtmesh-rpcd-") as tmp:
            root = Path(tmp)
            service = root / "rpcd"
            calls = root / "calls"
            service.write_text("#!/bin/sh\nprintf '%s\\n' \"$1\" >> " + shlex.quote(str(calls)) + "\n")
            service.chmod(0o700)
            for name in ("postinst", "postrm"):
                script = makefile.split(f"define Package/wrtmesh/{name}\n", 1)[1].split("\nendef", 1)[0]
                script = script.replace("$$", "$").replace("/etc/init.d/rpcd", str(service))
                env = {key: value for key, value in os.environ.items()
                       if key not in ("IPKG_INSTROOT", "IPKG_NO_SCRIPT")}
                for variables in ({"IPKG_INSTROOT": str(root / "image")}, {"IPKG_NO_SCRIPT": "1"}):
                    subprocess.run(["sh", "-s"], input=script, text=True, check=True, env=env | variables)
                    assert not calls.exists()
                subprocess.run(["sh", "-s"], input=script, text=True, check=True, env=env)
                assert calls.read_text().splitlines() == ["reload"]
                calls.unlink()

    check("install-and-removal-refresh-rpcd-without-editing-luci", rpcd_hooks)

    def defaults():
        for name in ("xr_roaming.config", "xr_mesh.config"):
            config = (package / "files" / name).read_text()
            assert all(not line.strip() or line.lstrip().startswith("#") for line in config.splitlines())
        conffiles = makefile.split("define Package/wrtmesh/conffiles\n", 1)[1].split("\nendef", 1)[0]
        assert conffiles.splitlines() == ["/etc/config/xr_roaming", "/etc/config/xr_mesh"]
        assert "uci-defaults" not in makefile
        helper = (package / "files/helper.sh").read_text()
        assert "CLI=/usr/sbin/hostapd_cli\n" in helper and "CLI_SHA=" not in helper
        assert "$(LN) /tmp/xr-roaming-public $(1)/www/xr-roaming" in makefile

    check("unconfigured-profile-and-package-persistence-contract", defaults)

    if args.installed_root:
        def payload():
            root = args.installed_root.resolve()
            for name in ["helper.sh", "common.jq", "cli-report.jq", "mesh.uc", "mesh-sample.uc", "mesh-daemon.sh"]:
                assert (root / "usr/lib/xr-roaming" / name).read_bytes() == (package / "files" / name).read_bytes()
            assert (root / "etc/init.d/xr_roaming").read_bytes() == (package / "files/xr_roaming.init").read_bytes()
            for destination, source in {
                "www/cgi-bin/xr-mesh": "xr-mesh.cgi",
                "usr/share/rpcd/ucode/xrmesh.uc": "xrmesh.uc",
                "usr/share/rpcd/acl.d/xrmesh.json": "xrmesh-acl.json",
                "usr/share/luci/menu.d/xrmesh.json": "xrmesh-menu.json",
                "www/luci-static/resources/xrmesh.js": "xrmesh.js",
                "www/luci-static/resources/view/network/xrmesh.js": "xrmesh-view.js",
                "www/luci-static/resources/view/status/include/65_wrtmesh.js": "65_wrtmesh.js",
            }.items():
                assert (root / destination).read_bytes() == (package / "files" / source).read_bytes()
            assert not (root / "www/luci-static/resources/view/status/include/60_wifi.js").exists()
            link = root / "www/xr-roaming"
            assert link.is_symlink() and os.readlink(link) == "/tmp/xr-roaming-public"
            assert not (root / "usr/lib/xr-roaming/hostapd_cli").exists()
            assert not (root / "lib/upgrade/keep.d/xr_roaming").exists()
        check("built-apk-runtime-and-symlink-match-current-source", payload)

    print(json.dumps({"passed": True, "scope": "local inert fixtures", "results": results}, indent=2))


if __name__ == "__main__":
    main()
