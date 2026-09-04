import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseEmbedderSpec, resolveEmbedConfig } from "./config.js";

describe("parseEmbedderSpec", () => {
  it("treats http(s):// as HTTP hooks", () => {
    expect(parseEmbedderSpec("http://127.0.0.1:8399")).toEqual({
      kind: "http",
      url: "http://127.0.0.1:8399",
    });
    expect(parseEmbedderSpec("https://embed.example.com/v1")).toEqual({
      kind: "http",
      url: "https://embed.example.com/v1",
    });
  });

  it("treats everything else as subprocess commands", () => {
    expect(parseEmbedderSpec("mrplex-embedder")).toEqual({
      kind: "cmd",
      command: "mrplex-embedder",
    });
    expect(parseEmbedderSpec("node ./embedder.mjs --model fast-bge-small-en-v1.5")).toEqual({
      kind: "cmd",
      command: "node ./embedder.mjs --model fast-bge-small-en-v1.5",
    });
    expect(parseEmbedderSpec("127.0.0.1:8399")).toEqual({
      kind: "cmd",
      command: "127.0.0.1:8399",
    });
  });

  it("rejects empty values", () => {
    expect(() => parseEmbedderSpec("   ")).toThrow(/--embedder is empty/);
  });
});

describe("resolveEmbedConfig", () => {
  const savedEnv = process.env;
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "mrplex-embed-config-"));
    // Hermetic setup, two ways. (1) Point the CLI config loader at an empty dir
    // so the host machine's ~/.config/mrplex/config.json — which may set
    // `embedder` — can't leak in; loadConfig() reads configPath() fresh on each
    // call and configPath() honors XDG_CONFIG_HOME. (2) Drop any inherited
    // MRPLEX_EMBEDDER (rebuilt per test rather than deleted).
    const { MRPLEX_EMBEDDER: _drop, ...rest } = savedEnv;
    process.env = { ...rest, XDG_CONFIG_HOME: configDir };
  });

  afterEach(() => {
    process.env = savedEnv;
    rmSync(configDir, { recursive: true, force: true });
  });

  /** Write a CLI config.json into the isolated XDG dir. */
  function writeConfig(cfg: Record<string, unknown>): void {
    const dir = join(configDir, "mrplex");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify(cfg));
  }

  it("returns { kind: none } when nothing is configured", () => {
    expect(resolveEmbedConfig({})).toEqual({ kind: "none" });
  });

  it("resolves an explicit --embedder command input", () => {
    expect(resolveEmbedConfig({ embedder: "mrplex-embedder" })).toEqual({
      kind: "cmd",
      command: "mrplex-embedder",
    });
  });

  it("resolves an explicit --embedder http(s):// input", () => {
    expect(resolveEmbedConfig({ embedder: "http://127.0.0.1:8399" })).toEqual({
      kind: "http",
      url: "http://127.0.0.1:8399",
    });
  });

  it("reads MRPLEX_EMBEDDER from the environment", () => {
    process.env.MRPLEX_EMBEDDER = "mrplex-embedder";
    expect(resolveEmbedConfig({})).toEqual({ kind: "cmd", command: "mrplex-embedder" });
  });

  it("falls back to the CLI config file's embedder", () => {
    writeConfig({ embedder: "http://embed.example.com" });
    expect(resolveEmbedConfig({})).toEqual({ kind: "http", url: "http://embed.example.com" });
  });

  it("precedence: input beats env beats config file", () => {
    writeConfig({ embedder: "from-config" });
    process.env.MRPLEX_EMBEDDER = "from-env";
    expect(resolveEmbedConfig({})).toEqual({ kind: "cmd", command: "from-env" });
    expect(resolveEmbedConfig({ embedder: "from-input" })).toEqual({
      kind: "cmd",
      command: "from-input",
    });
  });
});
