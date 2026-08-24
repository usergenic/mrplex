import { describe, expect, it } from "vitest";
import { canonicalContent, contentHash, contentHashOfFile } from "./content-hash.js";
import { appendSystemProperty, join } from "./frontmatter.js";

describe("canonicalContent", () => {
  it("excludes the document path (a pure move does not change the bytes)", () => {
    // No path is even an argument — content is frontmatter + body only.
    expect(canonicalContent("title: hi\n", "body\n")).toBe(
      join({
        frontmatter_raw: "title: hi\n",
        body: "body\n",
      }),
    );
  });

  it("collapses empty frontmatter to bare body", () => {
    expect(canonicalContent("", "just body\n")).toBe("just body\n");
  });
});

describe("contentHash", () => {
  it("is a bare lowercase hex sha-256 (64 chars, no prefix)", () => {
    const h = contentHash("title: hi\n", "body\n");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs when content differs", () => {
    expect(contentHash("", "a\n")).not.toBe(contentHash("", "b\n"));
  });
});

describe("contentHashOfFile — the three byte-exactness traps", () => {
  it("trap 1: empty-frontmatter collapse — injected block hashes same as bare body", () => {
    // Server stored a doc with frontmatter_raw === "" → hash of bare body.
    const stored = contentHash("", "hello body\n");
    // A read surface injected $version into that empty-frontmatter doc:
    const injectedRaw = appendSystemProperty("", "version", "v42");
    const fileText = join({ frontmatter_raw: injectedRaw, body: "hello body\n" });
    expect(fileText.startsWith("---\n")).toBe(true); // block is present on disk
    expect(contentHashOfFile(fileText)).toBe(stored);
  });

  it("trap 2: trailing-newline normalization — file lacking final FM newline hashes same", () => {
    const stored = contentHash("title: hi\n", "body\n");
    // A file whose frontmatter block was written without normalization still
    // round-trips because join forces the trailing newline.
    const fileText = "---\ntitle: hi\n---\nbody\n";
    expect(contentHashOfFile(fileText)).toBe(stored);
  });

  it("trap 3: line endings — CRLF hashes same as LF", () => {
    const stored = contentHash("title: hi\n", "line one\nline two\n");
    const crlf = "---\r\ntitle: hi\r\n---\r\nline one\r\nline two\r\n";
    expect(contentHashOfFile(crlf)).toBe(stored);
  });
});

describe("contentHashOfFile — embedded intrinsics are excluded", () => {
  it("adding or removing a $ line never changes the hash", () => {
    const base = "---\ntitle: hi\n---\nbody\n";
    const withVersion = "---\ntitle: hi\n$version: v42\n---\nbody\n";
    const withVersionAndHash = "---\ntitle: hi\n$version: v42\n$content_hash: abc\n---\nbody\n";
    const h = contentHashOfFile(base);
    expect(contentHashOfFile(withVersion)).toBe(h);
    expect(contentHashOfFile(withVersionAndHash)).toBe(h);
  });

  it("a $sync directive does not make a file look dirty", () => {
    const clean = "---\ntitle: hi\n$version: v42\n---\nbody\n";
    const withDirective = "---\ntitle: hi\n$version: v42\n$sync: ignore\n---\nbody\n";
    expect(contentHashOfFile(withDirective)).toBe(contentHashOfFile(clean));
  });
});

describe("contentHashOfFile(injectedRead) === storedHash", () => {
  it("holds for a doc materialized with both injected intrinsics", () => {
    // What the server stored:
    const frontmatterRaw = "title: My Note\ntags:\n  - a\n  - b\n";
    const body = "# Heading\n\nSome text.\n";
    const stored = contentHash(frontmatterRaw, body);

    // What a read surface materializes: append $version then $content_hash,
    // in fixed order, to the stored raw.
    let injected = appendSystemProperty(frontmatterRaw, "version", "v8421");
    injected = appendSystemProperty(injected, "content_hash", stored);
    const fileText = join({ frontmatter_raw: injected, body });

    expect(contentHashOfFile(fileText)).toBe(stored);
  });
});
