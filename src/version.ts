import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Package version — single source for CLI and MCP server metadata. */
export const VERSION: string = require("../package.json").version as string;
