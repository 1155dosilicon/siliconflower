import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = resolve(import.meta.dir, "..", "scripts", "install-appimage.sh");
const NAME = "siliconflower-desktop";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-install-"));
  dirs.push(dir);
  return dir;
}

/** A stand-in AppImage: like the real runtime, --appimage-extract writes ./squashfs-root. */
function fakeAppImage(dir: string, version: string, binary = NAME): string {
  const file = join(dir, `Siliconflower-${version}-x86_64.AppImage`);
  writeFileSync(file, `#!/bin/sh
[ "$1" = --appimage-extract ] || exit 2
mkdir -p squashfs-root/usr/share/icons/hicolor/256x256/apps
printf '#!/bin/sh\\necho "app ${version} $*"\\n' > squashfs-root/${binary}
chmod +x squashfs-root/${binary}
printf '[Desktop Entry]\\nName=Siliconflower\\nX-AppImage-Version=${version}\\n' > squashfs-root/${NAME}.desktop
printf 'png' > squashfs-root/usr/share/icons/hicolor/256x256/apps/${NAME}.png
touch squashfs-root/marker-${version}
`);
  chmodSync(file, 0o755);
  return file;
}

function run(home: string, ...args: string[]) {
  const env = { ...process.env, HOME: home, PATH: `${join(home, ".local", "bin")}:${process.env.PATH}` };
  delete env.XDG_DATA_HOME;
  delete env.SILICONFLOWER_INSTALL_DIR;
  return spawnSync("bash", [SCRIPT, ...args], { env, encoding: "utf8", cwd: home });
}

describe.skipIf(process.platform === "win32")("install-appimage.sh", () => {
  test("installs app, command, menu entry and icon for the user, without FUSE", () => {
    const home = tempDir();
    const res = run(home, fakeAppImage(tempDir(), "1.0.0"));
    expect(res.status).toBe(0);

    const share = join(home, ".local", "share");
    const launcher = join(home, ".local", "bin", NAME);
    const desktop = readFileSync(join(share, "applications", `${NAME}.desktop`), "utf8");
    expect(desktop).toContain(`Exec="${launcher}" %F`);
    expect(desktop).toContain(`Icon=${NAME}`);
    expect(desktop).toContain(`StartupWMClass=${NAME}`);
    expect(desktop).toContain("X-Siliconflower-Version=1.0.0");
    expect(readFileSync(join(share, "icons", "hicolor", "256x256", "apps", `${NAME}.png`), "utf8")).toBe("png");

    const launched = spawnSync(launcher, ["/projeto"], { encoding: "utf8" });
    expect(launched.stdout).toContain("app 1.0.0");
    expect(launched.stdout).toContain("/projeto");
  });

  test("an update replaces the old version and leaves nothing behind", () => {
    const home = tempDir();
    expect(run(home, fakeAppImage(tempDir(), "1.0.0")).status).toBe(0);
    expect(run(home, fakeAppImage(tempDir(), "2.0.0")).status).toBe(0);
    const appHome = join(home, ".local", "share", NAME);
    expect(existsSync(join(appHome, "app", "marker-2.0.0"))).toBe(true);
    expect(existsSync(join(appHome, "app", "marker-1.0.0"))).toBe(false);
    expect(spawnSync("ls", ["-A", appHome], { encoding: "utf8" }).stdout.trim()).toBe("app");
  });

  test("a file that is not the app fails and keeps the installed version", () => {
    const home = tempDir();
    expect(run(home, fakeAppImage(tempDir(), "1.0.0")).status).toBe(0);
    const res = run(home, fakeAppImage(tempDir(), "6.6.6", "outro-programa"));
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("não contém");
    expect(existsSync(join(home, ".local", "share", NAME, "app", "marker-1.0.0"))).toBe(true);
  });

  test("uninstall removes what it installed and keeps settings and conversations", () => {
    const home = tempDir();
    mkdirSync(join(home, ".siliconflower"));
    writeFileSync(join(home, ".siliconflower", "config.json"), "{}");
    expect(run(home, fakeAppImage(tempDir(), "1.0.0")).status).toBe(0);
    expect(run(home, "--uninstall").status).toBe(0);
    const share = join(home, ".local", "share");
    expect(existsSync(join(share, NAME))).toBe(false);
    expect(existsSync(join(home, ".local", "bin", NAME))).toBe(false);
    expect(existsSync(join(share, "applications", `${NAME}.desktop`))).toBe(false);
    expect(existsSync(join(share, "icons", "hicolor", "256x256", "apps", `${NAME}.png`))).toBe(false);
    expect(existsSync(join(home, ".siliconflower", "config.json"))).toBe(true);
  });

  test("without a path, finds the AppImage in the current folder", () => {
    const home = tempDir();
    fakeAppImage(home, "3.0.0");
    const res = run(home);
    expect(res.status).toBe(0);
    expect(existsSync(join(home, ".local", "share", NAME, "app", "marker-3.0.0"))).toBe(true);
  });
});
