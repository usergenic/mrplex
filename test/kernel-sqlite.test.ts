import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteAdapter } from "../src/storage-sqlite/adapter.js";
import { runKernelSuite } from "./kernel-suite.js";

runKernelSuite({
  name: "sqlite",
  open: () => {
    const path = join(tmpdir(), `mrplex-kernel-${Date.now()}-${Math.random()}.db`);
    return sqliteAdapter.open({ database: `sqlite:${path}` });
  },
});
