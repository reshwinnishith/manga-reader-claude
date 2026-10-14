import { describe, expect, it } from "vitest";
import { cleanDescription } from "./clean-description";

describe("cleanDescription", () => {
  it("returns empty text for missing input", () => {
    expect(cleanDescription(null)).toBe("");
    expect(cleanDescription(undefined)).toBe("");
    expect(cleanDescription("")).toBe("");
  });

  it("turns <br> into line breaks and strips other tags", () => {
    expect(cleanDescription("One<br>Two<br/><br />Three <i>four</i> <b>five</b>")).toBe("One\nTwo\n\nThree four five");
  });

  it("removes spoiler blocks, including multi-line and unterminated ones", () => {
    expect(cleanDescription("Safe ~!hidden!~ text")).toBe("Safe text");
    expect(cleanDescription("A ~!line one\nline two!~ B")).toBe("A B");
    expect(cleanDescription("Start ~!never closed")).toBe("Start");
  });

  it("decodes entities but never produces markup", () => {
    expect(cleanDescription("Fish &amp; Chips &quot;yum&quot; &#39;ok&#39; &#x2014; &nbsp;done")).toBe("Fish & Chips \"yum\" 'ok' — done");
    expect(cleanDescription("&lt;script&gt;alert(1)&lt;/script&gt;")).toBe("<script>alert(1)</script>"); // plain text; rendered as text only
    expect(cleanDescription("&bogus; &#99999999999;")).toBe("&bogus; &#99999999999;");
  });

  it("strips script tags and attributes written as real HTML", () => {
    expect(cleanDescription('<a href="javascript:x" onclick="y()">link</a><script>alert(1)</script>')).toBe("linkalert(1)");
  });

  it("tidies whitespace", () => {
    expect(cleanDescription("  a   b \n\n\n\n c  ")).toBe("a b\n\nc");
  });
});
