# mrplex

*Markdown Repos, plexed.* A hub for versioned markdown.

**Status:** M0 (walking skeleton) in progress. See [docs/design.md](docs/design.md) for the full design and [docs/m0-plan.md](docs/m0-plan.md) for the milestone plan.

## Quickstart

```bash
npm install
npm run build

# Seed a demo database from fixtures/
npm run seed -- --database ./demo.db

# CLI reads (M0)
npm run cli -- --database ./demo.db repos list
npm run cli -- --database ./demo.db docs get notes welcome.md
npm run cli -- --database ./demo.db docs history notes welcome.md
```

## Development

```bash
npm test          # run the full test suite
npm run typecheck # tsc --noEmit
npm run lint      # biome check
```

## License

TBD.
