import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tryResolvePathCaseInsensitive } from "../../infra/path-case.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { isSameFixedSessionStoreConfig, isSameSessionStoreConfig } from "./session-store-config.js";

describe("fixed session store identity", () => {
  it.runIf(process.platform !== "win32")(
    "canonicalizes dangling leaf and ancestor aliases for a missing owned store",
    async () => {
      await withTestDir({ prefix: "openclaw-fixed-store-alias-" }, async (root) => {
        const ownedStore = path.join(root, "future", "sessions.sqlite");
        const leafAlias = path.join(root, "leaf-alias.sqlite");
        const ancestorAlias = path.join(root, "ancestor-alias");
        await fs.symlink(ownedStore, leafAlias);
        await fs.symlink(path.dirname(ownedStore), ancestorAlias);

        expect(isSameFixedSessionStoreConfig(ownedStore, leafAlias, process.env)).toBe(true);
        expect(
          isSameFixedSessionStoreConfig(
            ownedStore,
            path.join(ancestorAlias, path.basename(ownedStore)),
            process.env,
          ),
        ).toBe(true);
        expect(
          isSameFixedSessionStoreConfig(
            ownedStore,
            path.join(root, "unrelated", "sessions.sqlite"),
            process.env,
          ),
        ).toBe(false);
      });
    },
  );

  it("treats pre-creation case variants as owned on case-insensitive filesystems", async () => {
    await withTestDir({ prefix: "openclaw-fixed-store-case-" }, async (root) => {
      const ownedStore = path.join(root, "Future", "Sessions.sqlite");
      const caseVariantStore = path.join(root, "future", "sessions.sqlite");
      await expect(fs.stat(ownedStore)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(caseVariantStore)).rejects.toMatchObject({ code: "ENOENT" });
      if (tryResolvePathCaseInsensitive(ownedStore) !== true) {
        return;
      }

      expect(isSameFixedSessionStoreConfig(ownedStore, caseVariantStore, process.env)).toBe(true);
      await expect(fs.stat(ownedStore)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(caseVariantStore)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});

describe("isSameSessionStoreConfig", () => {
  it("treats unset and empty per-agent configs as equivalent", () => {
    expect(isSameSessionStoreConfig(undefined, undefined, process.env)).toBe(true);
    expect(isSameSessionStoreConfig("", undefined, process.env)).toBe(true);
    expect(isSameSessionStoreConfig(undefined, "", process.env)).toBe(true);
    expect(isSameSessionStoreConfig("   ", undefined, process.env)).toBe(true);
  });

  it("treats matching per-agent templates as equivalent", () => {
    expect(
      isSameSessionStoreConfig(
        "stores/{agentId}/sessions.json",
        "stores/{agentId}/sessions.json",
        process.env,
      ),
    ).toBe(true);
    expect(
      isSameSessionStoreConfig(
        "./stores/{agentId}/sessions.json",
        "stores/{agentId}/sessions.json",
        process.env,
      ),
    ).toBe(true);
  });

  it("distinguishes unset per-agent stores from templated or fixed stores", () => {
    expect(isSameSessionStoreConfig(undefined, "stores/{agentId}/sessions.json", process.env)).toBe(
      false,
    );
    expect(isSameSessionStoreConfig(undefined, "/var/data/sessions.sqlite", process.env)).toBe(
      false,
    );
    expect(isSameSessionStoreConfig("/var/data/sessions.sqlite", undefined, process.env)).toBe(
      false,
    );
  });

  it("distinguishes different per-agent templates", () => {
    expect(
      isSameSessionStoreConfig(
        "stores-a/{agentId}/sessions.json",
        "stores-b/{agentId}/sessions.json",
        process.env,
      ),
    ).toBe(false);
  });

  it("delegates fixed store comparison to fixed store identity", () => {
    expect(
      isSameSessionStoreConfig(
        "/var/data/sessions.sqlite",
        "/var/data/sessions.sqlite",
        process.env,
      ),
    ).toBe(true);
    expect(
      isSameSessionStoreConfig(
        "/var/data/sessions-a.sqlite",
        "/var/data/sessions-b.sqlite",
        process.env,
      ),
    ).toBe(false);
  });

  it("preserves runtime path whitespace and treats whitespace variants as transitions", () => {
    expect(
      isSameSessionStoreConfig(
        "stores/{agentId}/sessions.json",
        " stores/{agentId}/sessions.json",
        process.env,
      ),
    ).toBe(false);
    expect(
      isSameSessionStoreConfig(
        "stores/{agentId}/sessions.json",
        "stores/{agentId}/sessions.json ",
        process.env,
      ),
    ).toBe(false);
  });
});
