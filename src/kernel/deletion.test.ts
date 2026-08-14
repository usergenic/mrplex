import { describe, expect, it } from "vitest";
import {
  deletionPath,
  pathIsInSystemNamespace,
  splitExtension,
  withVersionSuffix,
} from "./deletion.js";

describe("splitExtension", () => {
  it.each([
    ["hello.md", { basename: "hello", extension: ".md" }],
    ["README", { basename: "README", extension: "" }],
    [".gitignore", { basename: ".gitignore", extension: "" }],
    ["foo.tar.gz", { basename: "foo.tar", extension: ".gz" }],
    [".env.production", { basename: ".env", extension: ".production" }],
    ["document.md.bak", { basename: "document.md", extension: ".bak" }],
    ["nodot", { basename: "nodot", extension: "" }],
    ["", { basename: "", extension: "" }],
  ])("%j → %o", (input, expected) => {
    expect(splitExtension(input)).toEqual(expected);
  });
});

describe("withVersionSuffix", () => {
  it.each([
    ["hello.md", "v45129", "hello-v45129.md"],
    ["notes/readme.md", "v1", "notes/readme-v1.md"],
    ["a/b/c/d.md", "v9999", "a/b/c/d-v9999.md"],
    ["README", "v42", "README-v42"],
    [".gitignore", "v42", ".gitignore-v42"],
    ["notes/foo.tar.gz", "v42", "notes/foo.tar-v42.gz"],
    // Even a doc literally named to look like a trash suffix stays unique
    // because version_ids are unique and the suffix is always appended.
    ["notes/a-v42.md", "v99", "notes/a-v42-v99.md"],
  ])("%j @ %s → %j", (path, versionId, expected) => {
    expect(withVersionSuffix(path, versionId)).toBe(expected);
  });
});

describe("deletionPath", () => {
  it("produces the design's canonical example", () => {
    expect(deletionPath(":", "path/to/document.md", "v45129")).toBe(
      ":deleted/path/to/document-v45129.md",
    );
  });
  it("honors a non-default system sigil", () => {
    expect(deletionPath("#", "foo.md", "v1")).toBe("#deleted/foo-v1.md");
  });
  it("honors a multi-character system sigil", () => {
    expect(deletionPath("__sys_", "notes/hello.md", "v1")).toBe("__sys_deleted/notes/hello-v1.md");
  });
  it("preserves extension terminality for a dotfile", () => {
    expect(deletionPath(":", ".gitignore", "v1")).toBe(":deleted/.gitignore-v1");
  });
});

describe("pathIsInSystemNamespace", () => {
  it("true for a path starting with the sigil", () => {
    expect(pathIsInSystemNamespace(":deleted/notes/foo.md", [":"])).toBe(true);
  });
  it("true for any segment starting with a sigil", () => {
    expect(pathIsInSystemNamespace("notes/:special.md", [":"])).toBe(true);
  });
  it("false when no segment matches", () => {
    expect(pathIsInSystemNamespace("notes/foo.md", [":"])).toBe(false);
  });
  it("false for an empty path", () => {
    expect(pathIsInSystemNamespace("", [":"])).toBe(false);
  });
  it("honors multi-character sigils", () => {
    expect(pathIsInSystemNamespace("__sys_deleted/foo.md", ["__sys_"])).toBe(true);
    expect(pathIsInSystemNamespace("_notsys/foo.md", ["__sys_"])).toBe(false);
  });
});
