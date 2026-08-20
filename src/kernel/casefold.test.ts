import { describe, expect, it } from "vitest";
import { normalizeKey } from "./casefold.js";

describe("normalizeKey — ASCII case folding", () => {
  it("lowercases ASCII", () => {
    expect(normalizeKey("Alice.md")).toBe("alice.md");
    expect(normalizeKey("ALICE.MD")).toBe("alice.md");
    expect(normalizeKey("MixedCase/Path.md")).toBe("mixedcase/path.md");
  });

  it("leaves already-lowercase unchanged", () => {
    expect(normalizeKey("alice.md")).toBe("alice.md");
  });

  it("preserves the path separator (ASCII, fold-invariant)", () => {
    expect(normalizeKey("A/B/C.md")).toBe("a/b/c.md");
  });

  it("preserves spaces and other punctuation", () => {
    expect(normalizeKey("My Note (2024).md")).toBe("my note (2024).md");
  });
});

describe("normalizeKey — Unicode normalization (NFC/NFD)", () => {
  // "cafe" + acute, composed (NFC, \u00e9) vs decomposed (NFD, e + \u0301).
  // Built from escapes so the two are provably distinct byte strings
  // regardless of how this source file is saved.
  const nfc = "caf\u00e9.md";
  const nfd = "cafe\u0301.md";

  it("folds NFC and NFD spellings of the same text to the same key", () => {
    expect(nfc).not.toBe(nfd); // sanity: they are different byte strings
    expect(normalizeKey(nfc)).toBe(normalizeKey(nfd));
  });

  it("emits NFC output (decomposed input recomposes)", () => {
    expect(normalizeKey(nfd)).toBe("caf\u00e9.md");
  });
});

describe("normalizeKey — accented Latin/Greek/Cyrillic (in-scope folds)", () => {
  it("folds accented Latin case", () => {
    expect(normalizeKey("CAFÉ.md")).toBe(normalizeKey("café.md"));
    expect(normalizeKey("ÜBER")).toBe(normalizeKey("über"));
  });

  it("folds Cyrillic case", () => {
    expect(normalizeKey("СТ")).toBe("ст");
  });

  it("folds basic Greek case", () => {
    expect(normalizeKey("ΑΒΓ")).toBe("αβγ");
  });
});

describe("normalizeKey — locale invariance (Turkish-I)", () => {
  it("folds I to i regardless of host locale (not toLocaleLowerCase)", () => {
    // A locale fold under "tr" would map I → ı (dotless). Identity must be
    // locale-independent, so ASCII I always folds to ASCII i.
    expect(normalizeKey("ISTANBUL")).toBe("istanbul");
  });
});

describe("normalizeKey — asserted NON-folds (boundary of the chosen strength)", () => {
  // Decision 4: NFC + toLowerCase() does NOT do full Unicode case folding.
  // These are the known gaps; pinned so the boundary is explicit and a
  // future upgrade to full-fold is a conscious, tested change.
  it("does NOT fold German ß to ss", () => {
    expect(normalizeKey("Straße")).not.toBe(normalizeKey("STRASSE"));
  });

  it("does NOT fold ligatures", () => {
    expect(normalizeKey("ﬁle")).not.toBe(normalizeKey("file"));
  });
});

describe("normalizeKey — contract", () => {
  it("is idempotent", () => {
    for (const s of ["Alice.md", "café.md", "СТ", "Straße", "ﬁle", "ΑΣ"]) {
      expect(normalizeKey(normalizeKey(s))).toBe(normalizeKey(s));
    }
  });

  it("handles the empty string", () => {
    expect(normalizeKey("")).toBe("");
  });
});
