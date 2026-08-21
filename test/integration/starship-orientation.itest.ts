/**
 * Session: a new executive officer's first hour aboard the USS Meridian.
 *
 * Reads top to bottom as one continuous orientation — each step is a question
 * the XO might ask the ship's knowledge base, and the assertion is the answer
 * the graph gives back. The whole session runs against one freshly-seeded
 * `starship` repo (see fixtures/starship/), so it doubles as documentation of
 * what the shipped fixture can demonstrate: frontmatter reference-fields,
 * backlink hubs, MOC membership, and plain frontmatter filters.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Session, starshipSession } from "./support.js";

describe("USS Meridian — orientation session", () => {
  let s: Session;
  beforeEach(async () => {
    s = await starshipSession();
  });
  afterEach(async () => {
    await s.cleanup();
  });

  it("walks the XO from chain-of-command to a broken-equipment thread", async () => {
    // 1. "Who reports directly to the captain?" — the reports_to frontmatter
    //    field is a link edge, so this is a reverse-edge (has) query.
    expect(await s.query('$has_static("crew/kestrel-vance.md", "reports_to")')).toEqual([
      "crew/aria-okonkwo.md",
      "crew/dax-thorne.md",
      "crew/quill-vasquez.md",
    ]);

    // 2. "And who reports to the first officer?"
    expect(await s.query('$has_static("crew/aria-okonkwo.md", "reports_to")')).toEqual([
      "crew/isolde-marsh.md",
      "crew/soren-halloway.md",
    ]);

    // 3. "Show me the crew roster." — the MOC is a hand-curated wikilink index;
    //    membership means "linked from moc/crew.md".
    expect(await s.query('$in_static("moc/crew.md")')).toEqual([
      "crew/aria-okonkwo.md",
      "crew/bexley-orr.md",
      "crew/dax-thorne.md",
      "crew/isolde-marsh.md",
      "crew/kestrel-vance.md",
      "crew/quill-vasquez.md",
      "crew/soren-halloway.md",
    ]);

    // 4. "Who does everyone talk about?" — the most-referenced officer. The
    //    first officer reads every log, so she's the busiest hub in the graph.
    const hubs = await s.query("$backlinks_static().size() >= 6");
    expect(hubs).toContain("crew/aria-okonkwo.md");
    expect(hubs).toContain("crew/kestrel-vance.md");
    // A leaf like the ration bars is never a hub.
    expect(hubs).not.toContain("equipment/emergency-ration-bars.md");

    // 5. "What's broken or down right now?" — a plain frontmatter filter, no
    //    graph involved.
    expect(await s.query('status == "damaged" || status == "offline"')).toEqual([
      "equipment/plasma-manifold-3.md",
      "equipment/shuttle-corvid.md",
    ]);

    // 6. "Who maintains the damaged manifold, and what else touches it?" — the
    //    reverse edge across ALL fields (maintainer, related, body links, logs).
    const touchesManifold = await s.query('$has_static("equipment/plasma-manifold-3.md")');
    expect(touchesManifold).toContain("crew/bexley-orr.md"); // maintainer field
    expect(touchesManifold).toContain("logs/thorne-4413-2.md"); // a log body-links it
    expect(touchesManifold).toContain("equipment/coolant-loop-b.md"); // related field
  });
});
