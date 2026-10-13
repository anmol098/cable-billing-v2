import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ANDROID_DRAWABLE_DIR } from "./android";
import {
  compareIconOutputs,
  generateIcons,
  loadIconManifest,
  loadLucide,
  writeIconOutputs,
} from "./fs";
import { IconManifestError } from "./manifest";
import { androidDrawablePath, LUCIDE_LICENSE_PATH, renderIconOutputs } from "./outputs";
import { REACT_ICONS_PATH } from "./react";

describe("icon outputs", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const tempRoot = () => {
    const root = mkdtempSync(join(tmpdir(), "cb-icons-"));
    temps.push(root);
    return root;
  };

  it("are the React map, the Lucide licence and one drawable per icon", () => {
    const manifest = loadIconManifest();
    expect(generateIcons().map((file) => file.path)).toEqual([
      REACT_ICONS_PATH,
      LUCIDE_LICENSE_PATH,
      ...manifest.map(({ name }) => androidDrawablePath(name)),
    ]);
  });

  it("covers the semantic names the plan asks for (T-003 scope, PLAN §2.2)", () => {
    const names = loadIconManifest().map(({ name }) => name);
    for (const name of [
      "cash",
      "upi",
      "pending",
      "success",
      "danger",
      "search",
      "customer",
      "collect",
      "print",
      "whatsapp",
      "sms",
      "handover",
      "settings",
      "back",
      "add",
      "bill",
      "home",
      "lineman",
      "logout",
      "language",
    ]) {
      expect(names).toContain(name);
    }
  });

  it("adding a name to icons.json makes it available on both platforms", () => {
    const manifest = [...loadIconManifest(), { name: "close-dialog", lucide: "x" }];
    const files = renderIconOutputs(manifest, loadLucide());
    const react = files.find((file) => file.path === REACT_ICONS_PATH)?.content ?? "";
    expect(react).toContain('  // Lucide "x"\n  "close-dialog": [');
    const drawable = files.find(
      (file) => file.path === `${ANDROID_DRAWABLE_DIR}/ic_cb_close_dialog.xml`,
    );
    expect(drawable?.content).toContain('"close-dialog" = Lucide "x"');
    expect(drawable?.content).toContain('android:pathData="M18 6 L6 18"');
  });

  it("an unknown or alias Lucide name fails with a readable error", () => {
    const manifest = [{ name: "audit", lucide: "history" }];
    expect(() => renderIconOutputs(manifest, loadLucide())).toThrow(IconManifestError);
    expect(() => renderIconOutputs(manifest, loadLucide())).toThrow(
      'audit: "history" is not a Lucide icon',
    );
  });

  it("the committed files match icons.json (same as `icons:build --check`)", () => {
    const stale = compareIconOutputs(generateIcons()).filter((file) => file.status !== "unchanged");
    expect(stale).toEqual([]);
  });

  it("writes missing files, then reports edits and deletes leftover ic_cb_ drawables", () => {
    const root = tempRoot();
    const files = generateIcons();
    expect(compareIconOutputs(files, root).every((file) => file.status === "missing")).toBe(true);

    writeIconOutputs(files, root);
    expect(compareIconOutputs(files, root).every((file) => file.status === "unchanged")).toBe(true);
    expect(readFileSync(join(root, REACT_ICONS_PATH), "utf8")).toContain("export const ICON_NODES");

    const leftover = `${ANDROID_DRAWABLE_DIR}/ic_cb_removed.xml`;
    const unrelated = `${ANDROID_DRAWABLE_DIR}/ic_launcher_foreground.xml`;
    writeFileSync(join(root, leftover), "<vector/>");
    writeFileSync(join(root, unrelated), "<vector/>");
    writeFileSync(join(root, androidDrawablePath("cash")), "edited");
    expect(compareIconOutputs(files, root).filter((file) => file.status !== "unchanged")).toEqual([
      { path: androidDrawablePath("cash"), status: "changed" },
      { path: leftover, status: "extra" },
    ]);

    writeIconOutputs(files, root);
    expect(compareIconOutputs(files, root).every((file) => file.status === "unchanged")).toBe(true);
    expect(() => readFileSync(join(root, leftover))).toThrow();
    expect(readFileSync(join(root, unrelated), "utf8")).toBe("<vector/>");
  });

  it("no drawable directory yet is not an error", () => {
    const root = tempRoot();
    mkdirSync(join(root, "apps"), { recursive: true });
    expect(compareIconOutputs(generateIcons(), root).some((file) => file.status === "extra")).toBe(
      false,
    );
  });
});
