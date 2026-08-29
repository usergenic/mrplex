import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseEmbedderSpec,
  resolveEmbedConfig,
} from "./config.js";

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
  const env = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...env };
    delete process.env.MRPLEX_EMBEDDER;
    delete process.env.MRPLEX_EMBED_URL;
    delete process.env.MRPLEX_EMBED_CMD;
  });

  afterEach(() => {
    process.env = env;
  });

  it("errors when --embedder is combined with a legacy flag", () => {
    expect(() =>
      resolveEmbedConfig({
        embedder: "mrplex-embedder",
        embed_url: "http://127.0.0.1:1",
      }),
    ).toThrow(/mutually exclusive/);
  });

  it("errors when multiple source kinds are configured", () => {
    expect(() =>
      resolveEmbedConfig({
        embed_url: "http://127.0.0.1:8399",
        embed_cmd: "mrplex-embedder",
      }),
    ).toThrow(/mutually exclusive/);
  });

  it("still resolves legacy url and cmd inputs", () => {
    expect(resolveEmbedConfig({ embed_url: "http://127.0.0.1:8399" })).toEqual({
      kind: "http",
      url: "http://127.0.0.1:8399",
    });
    expect(resolveEmbedConfig({ embed_cmd: "mrplex-embedder" })).toEqual({
      kind: "cmd",
      command: "mrplex-embedder",
    });
  });

  it("reads MRPLEX_EMBEDDER from the environment", () => {
    process.env.MRPLEX_EMBEDDER = "mrplex-embedder";
    expect(resolveEmbedConfig({})).toEqual({ kind: "cmd", command: "mrplex-embedder" });
  });
});
