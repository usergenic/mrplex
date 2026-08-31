/**
 * Hot-path gate and inbound decision table (better-sync.plan).
 */

import { describe, expect, it } from "vitest";
import { contentHashOfFile } from "../src/markdown/content-hash.js";
import {
  decideInbound,
  enqueueDeferred,
  isDeferExpired,
  isPathHot,
  versionAtOrAhead,
} from "../src/sync/hot-path.js";
import type { Version, VersionRef } from "../src/kernel/wire.js";

function version(partial: Partial<Version> & { version_id: string; content_hash: string }): Version {
  return {
    prev_version_id: null,
    next_version_id: null,
    repo: "notes",
    path: "a.md",
    frontmatter: {},
    frontmatter_raw: "",
    body: "x\n",
    author: "t",
    created_at: "2020-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("isPathHot", () => {
  it("is never hot when settleMs is 0", () => {
    expect(isPathHot(Date.now(), 0, Date.now())).toBe(false);
  });

  it("is never hot when the file is absent", () => {
    expect(isPathHot(null, 5000, Date.now())).toBe(false);
  });

  it("is hot when mtime is within the settle window", () => {
    expect(isPathHot(1000, 500, 1400)).toBe(true);
  });

  it("is cold when mtime is at or older than settleMs", () => {
    expect(isPathHot(1000, 500, 1500)).toBe(false);
    expect(isPathHot(1000, 500, 2000)).toBe(false);
  });
});

describe("versionAtOrAhead", () => {
  it("treats missing local version as behind", () => {
    expect(versionAtOrAhead(undefined, "v2")).toBe(false);
  });

  it("treats equal and later ids as ahead", () => {
    expect(versionAtOrAhead("v3", "v3")).toBe(true);
    expect(versionAtOrAhead("v4", "v3")).toBe(true);
    expect(versionAtOrAhead("v2", "v3")).toBe(false);
  });
});

describe("decideInbound", () => {
  const remote = version({ version_id: "v2", content_hash: "abc", body: "remote\n" });

  it("noops an ignored file", () => {
    const d = decideInbound({
      localText: "---\n$sync: ignore\n---\nwhatever\n",
      remote,
      hot: true,
      canDefer: true,
    });
    expect(d.action).toBe("noop");
  });

  it("noops when local already names the remote version and hashes match", () => {
    const d = decideInbound({
      localText: "---\n$version: v2\n$content_hash: abc\n---\nremote\n",
      remote,
      hot: false,
      canDefer: false,
    });
    expect(d.action).toBe("noop");
  });

  it("adopts when hashes match but provenance lags (cold)", () => {
    const body = "same bytes\n";
    const local = "---\n$version: v1\n$content_hash: not-the-real-hash\n---\n" + body;
    const hash = contentHashOfFile(local);
    const d = decideInbound({
      localText: local,
      remote: version({ version_id: "v2", content_hash: hash, body }),
      hot: false,
      canDefer: true,
    });
    expect(d.action).toBe("adopt");
  });

  it("defers dirty+divergent when hot and canDefer", () => {
    const d = decideInbound({
      localText: "---\n$version: v1\n$content_hash: deadbeef\n---\nlocal edit\n",
      remote,
      hot: true,
      canDefer: true,
    });
    expect(d.action).toBe("defer");
  });

  it("rebases dirty+divergent when cold", () => {
    const d = decideInbound({
      localText: "---\n$version: v1\n$content_hash: deadbeef\n---\nlocal edit\n",
      remote,
      hot: false,
      canDefer: true,
    });
    expect(d.action).toBe("rebase");
    if (d.action === "rebase") expect(d.prevVersionId).toBe("v2");
  });

  it("does not defer when canDefer is false even if hot", () => {
    const d = decideInbound({
      localText: "---\n$version: v1\n$content_hash: deadbeef\n---\nlocal edit\n",
      remote,
      hot: true,
      canDefer: false,
    });
    expect(d.action).toBe("rebase");
  });
});

describe("enqueueDeferred", () => {
  it("keeps the newer version_id and original since", () => {
    const map = new Map();
    const older: VersionRef = {
      version_id: "v2",
      prev_version_id: "v1",
      repo: "notes",
      path: "a.md",
      prev_path: "a.md",
      content_hash: "x",
      op: "update",
      created_at: "",
    };
    const newer: VersionRef = { ...older, version_id: "v5" };
    enqueueDeferred(map, "a.md", older, 1000);
    enqueueDeferred(map, "a.md", newer, 2000);
    expect(map.get("a.md")?.ref.version_id).toBe("v5");
    expect(map.get("a.md")?.since).toBe(1000);
  });

  it("does not replace with an older version_id", () => {
    const map = new Map();
    const newer: VersionRef = {
      version_id: "v5",
      prev_version_id: "v4",
      repo: "notes",
      path: "a.md",
      prev_path: "a.md",
      content_hash: "x",
      op: "update",
      created_at: "",
    };
    enqueueDeferred(map, "a.md", newer, 1000);
    enqueueDeferred(map, "a.md", { ...newer, version_id: "v3" }, 2000);
    expect(map.get("a.md")?.ref.version_id).toBe("v5");
  });
});

describe("isDeferExpired", () => {
  it("expires after the TTL", () => {
    const entry = {
      ref: {
        version_id: "v1",
        prev_version_id: null,
        repo: "notes",
        path: "a.md",
        prev_path: null,
        content_hash: "x",
        op: "update" as const,
        created_at: "",
      },
      since: 0,
    };
    expect(isDeferExpired(entry, 1000, 5000)).toBe(false);
    expect(isDeferExpired(entry, 5000, 5000)).toBe(true);
  });
});
