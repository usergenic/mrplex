/**
 * Session: investigating the disappearance of Lieutenant Halloway, and the
 * shape of the repo's graph around it.
 *
 * This walkthrough leans on full-text search, mission↔encounter↔crew edges,
 * and the graph's negative space (orphans and leaves) — the parts of mrplex
 * that a flat document store can't answer. One freshly-seeded `starship` repo,
 * ordered steps, read top to bottom.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Session, starshipSession } from "./support.js";

describe("USS Meridian — investigation session", () => {
  let s: Session;
  beforeEach(async () => {
    s = await starshipSession();
  });
  afterEach(async () => {
    await s.cleanup();
  });

  it("follows the Halloway thread through search and the link graph", async () => {
    // 1. "Everything that mentions Halloway." — full-text across the corpus.
    expect(await s.textSearch("Halloway")).toEqual([
      "crew/soren-halloway.md",
      "encounters/the-hollow-signal.md",
      "logs/okonkwo-4415-1.md",
      "missions/the-hollow-signal.md",
      "moc/crew.md",
    ]);

    // 2. "He's flagged how in his file?" — a frontmatter filter finds the one
    //    officer who isn't active.
    expect(await s.query('status == "missing"')).toEqual(["crew/soren-halloway.md"]);

    // 3. "What mission was he on?" — the encounter carries the mission edge;
    //    the mission carries the crew edge. Pull the missions that list him.
    expect(await s.query('$has_static("crew/soren-halloway.md", "crew")')).toEqual([
      "missions/the-hollow-signal.md",
    ]);

    // 4. "Which missions did the first officer command?" — commander edge.
    expect(await s.query('$has_static("crew/aria-okonkwo.md", "commander")')).toEqual([
      "missions/the-cinder-run.md",
      "missions/the-hollow-signal.md",
    ]);

    // 5. "The mission log index — what's on it?" — MOC membership again, and
    //    note the MOC cross-links to the encounters MOC, so that shows up too.
    expect(await s.query('$in_static("moc/missions.md")')).toEqual([
      "missions/the-cinder-run.md",
      "missions/the-drift-choir.md",
      "missions/the-hollow-signal.md",
      "missions/the-silent-beacon.md",
      "moc/encounters.md",
    ]);

    // 6. "What's disconnected — notes nothing points at?" — the graph's
    //    negative space. Orphans include the deliberately-unlinked ficus and
    //    the ration bars.
    const orphans = await s.query('!$in_static("**")');
    expect(orphans).toContain("misc/the-galley-ficus.md");
    expect(orphans).toContain("equipment/emergency-ration-bars.md");
    // A mission is always reachable (from its MOC), so never an orphan.
    expect(orphans).not.toContain("missions/the-hollow-signal.md");

    // 7. "And true leaves — notes that link out to nothing?" — the ficus links
    //    to nothing and nothing links to it: a fully isolated node.
    const leaves = await s.query("$links_static().size() == 0");
    expect(leaves).toContain("misc/the-galley-ficus.md");
    expect(leaves).toContain("equipment/emergency-ration-bars.md");
  });
});
