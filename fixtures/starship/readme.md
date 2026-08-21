# USS Meridian — Ship's Knowledge Base

A sample mrplex repository: the operational notes, crew files, mission records, encounter logs, and equipment status of a fictional survey starship. Every entry is deliberately short — one idea, one to three paragraphs, zettelkasten-style — so the repo reads as a connected graph rather than a handful of long documents.

It exists to exercise mrplex end to end: links, backlinks, frontmatter reference-fields, graph queries, filters, and full-text search all have something real to bite on here.

## Layout

- `crew/` — officer files. Frontmatter `reports_to` builds the chain of command; heavily backlinked from logs and missions (the graph's hubs).
- `missions/` — mission records. Frontmatter `commander` and `crew` link to the officers involved.
- `encounters/` — what the missions found. Linked from missions and logs via `mission`.
- `equipment/` — ship systems, each with a `status` (operational / damaged / offline) and a `maintainer`.
- `logs/` — officer logs. Prose-heavy, so they drive full-text search and produce most of the backlinks.
- `moc/` — maps of content: hand-curated wikilink indexes that make membership queries meaningful.
- `misc/` — a home for the deliberately-unconnected (see the ficus).

## Link configuration

This repo opts the following frontmatter fields into the link graph:

```json
{ "fields": ["reports_to", "commander", "crew", "author", "mission", "maintainer", "related"] }
```

Body links use wikilinks (`[[crew/kestrel-vance]]`) and inline links; frontmatter fields use repo-absolute paths (`/crew/kestrel-vance.md`).

## Example queries

```bash
# Who reports directly to the captain?
mrplex -r starship query --filter '$in_static("crew/kestrel-vance.md", "reports_to")'

# Which officer does the whole ship reference? (the hubs)
mrplex -r starship query --filter '$backlinks_static().size() >= 4'

# What's broken right now?
mrplex -r starship query --filter 'status == "damaged" || status == "offline"'

# Which missions did Okonkwo command?
mrplex -r starship query --filter '$has_static("crew/aria-okonkwo.md", "commander")'

# Every mission indexed by the mission MOC
mrplex -r starship query --filter '$in_static("moc/missions.md")'

# Leaf notes that link to nothing
mrplex -r starship query --filter '$links_static().size() == 0'

# Orphans nobody references
mrplex -r starship query --filter '!$in_static("**")'

# Full-text across the logs
mrplex -r starship query --text 'manifold coolant'
```
