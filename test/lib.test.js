// Unit tests for the pure helpers in public/lib.js.
// These import the EXACT module the page ships, so a green run means the page
// logic is green too. Run with: npm test  (node --test, zero dependencies).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  esc, safeUrl, domainOf, registrableSld, isYou, plainAnswer, mdAnswer,
  normKey, citationsOf, brandInText, brandCitedPos, renderAnswer, csvCell,
} from "../public/lib.js";

test("esc escapes HTML-significant characters and nullish input", () => {
  assert.equal(esc('<a href="x">&\''), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
  assert.equal(esc(0), "0");
});

test("safeUrl only passes http(s); blocks javascript:/data:/ftp:", () => {
  assert.equal(safeUrl("https://x.com"), "https://x.com");
  assert.equal(safeUrl("http://x.com"), "http://x.com");
  assert.equal(safeUrl("  https://x.com  "), "https://x.com");
  assert.equal(safeUrl("javascript:alert(1)"), "");
  assert.equal(safeUrl("data:text/html,x"), "");
  assert.equal(safeUrl("ftp://x.com"), "");
  assert.equal(safeUrl(null), "");
});

test("domainOf normalizes host and strips www", () => {
  assert.equal(domainOf("https://www.roaspig.com/path?q=1"), "roaspig.com");
  assert.equal(domainOf("roaspig.com"), "roaspig.com");
  assert.equal(domainOf("www.roaspig.com"), "roaspig.com");
  assert.equal(domainOf("https://sub.example.co.uk/x"), "sub.example.co.uk");
  assert.equal(domainOf(""), "");
});

test("registrableSld returns the second-level label, with multi-part TLDs", () => {
  assert.equal(registrableSld("www.roaspig.com"), "roaspig");
  assert.equal(registrableSld("roaspig.com"), "roaspig");
  assert.equal(registrableSld("blog.roaspig.com"), "roaspig");
  assert.equal(registrableSld("roaspig.co.uk"), "roaspig");
  assert.equal(registrableSld("foo.bar.co.uk"), "bar");
  assert.equal(registrableSld("localhost"), "localhost");
});

test("isYou matches the registrable name, not arbitrary sub-labels", () => {
  assert.equal(isYou("roaspig.com", "roaspig"), true);
  assert.equal(isYou("www.roaspig.com", "roaspig"), true);
  assert.equal(isYou("blog.roaspig.com", "roaspig"), true);
  assert.equal(isYou("roaspig.co.uk", "Roas Pig"), true);
  // Impersonation / false-positive guards:
  assert.equal(isYou("roaspig.evil.com", "roaspig"), false);
  assert.equal(isYou("example.com", "com"), false);
  assert.equal(isYou("x.com", "ab"), false); // brand shorter than 3 chars
  assert.equal(isYou("", "roaspig"), false);
  assert.equal(isYou("roaspig.com", ""), false);
});

test("plainAnswer / mdAnswer pick the right field with fallbacks", () => {
  assert.equal(plainAnswer({ answer_text: "hi" }), "hi");
  assert.equal(plainAnswer({ answer: "yo" }), "yo");
  assert.equal(plainAnswer(null), "");
  assert.equal(mdAnswer({ answer_text_markdown: "**hi**" }), "**hi**");
  assert.equal(mdAnswer({ answer_text: "hi" }), "hi");
  assert.equal(mdAnswer(null), "");
});

test("normKey drops query/hash/trailing slash and www, and lowercases", () => {
  assert.equal(normKey("https://www.x.com/a/?q=1#h"), "x.com/a");
  assert.equal(normKey("https://x.com/a/"), "x.com/a");
  assert.equal(normKey("x.com/A"), "x.com/a");
  assert.equal(normKey("https://www.x.com/"), "x.com");
});

test("citationsOf dedupes, drops cited:false, and re-ranks 1..n by position", () => {
  const rec = {
    citations: [
      { url: "https://www.a.com/x?utm=1", title: "A", position: 2 },
      { url: "https://a.com/x", title: "A duplicate", position: 5 }, // same normKey -> dropped
      { url: "https://b.com", title: "B", cited: false },           // explicitly not cited -> dropped
      { url: "https://c.com", title: "C", position: 1 },
    ],
  };
  const out = citationsOf(rec);
  assert.equal(out.length, 2);
  assert.equal(out[0].domain, "c.com");
  assert.equal(out[0].position, 1);
  assert.equal(out[1].domain, "a.com");
  assert.equal(out[1].position, 2);
});

test("citationsOf falls back to the first non-empty source array", () => {
  const out = citationsOf({ citations: [], sources: [{ url: "https://s.com" }] });
  assert.equal(out.length, 1);
  assert.equal(out[0].domain, "s.com");
  assert.equal(out[0].position, 1);
  assert.deepEqual(citationsOf(null), []);
  assert.deepEqual(citationsOf({}), []);
});

test("brandInText matches whole words only (the 'metadata' guard)", () => {
  assert.equal(brandInText("I love Roas Pig today", "Roas Pig"), true);
  assert.equal(brandInText("use Roas-Pig now", "Roas Pig"), true); // hyphen variant
  assert.equal(brandInText("metadata", "meta"), false);            // substring, not a word
  assert.equal(brandInText("the meta tag", "meta"), true);
  assert.equal(brandInText("", "x"), false);
  assert.equal(brandInText("hello", ""), false);
  assert.equal(brandInText("hello", "a"), false); // < 2 chars
});

test("brandCitedPos returns the position of the brand's own citation", () => {
  const cites = [{ domain: "a.com", position: 1 }, { domain: "roaspig.com", position: 2 }];
  assert.equal(brandCitedPos(cites, "roaspig"), 2);
  assert.equal(brandCitedPos([{ domain: "a.com", position: 1 }], "roaspig"), null);
});

test("renderAnswer escapes first, then highlights the brand and light markdown", () => {
  // XSS: scraped HTML must be neutralized.
  const xss = renderAnswer("<img src=x onerror=alert(1)>", "");
  assert.ok(!xss.includes("<img"));
  assert.ok(xss.includes("&lt;img"));
  // Brand highlight (whole word) survives escaping.
  const hi = renderAnswer("I use Roaspig daily", "Roaspig");
  assert.ok(hi.includes("<mark>Roaspig</mark>"));
  // Light markdown.
  assert.ok(renderAnswer("# Heading", "").includes("<strong>Heading</strong>"));
  assert.ok(renderAnswer("**bold**", "").includes("<strong>bold</strong>"));
});

test("csvCell neutralizes formula injection and escapes quotes", () => {
  assert.equal(csvCell("=cmd()"), "\"'=cmd()\"");
  assert.equal(csvCell("+1"), "\"'+1\"");
  assert.equal(csvCell("-1"), "\"'-1\"");
  assert.equal(csvCell("@x"), "\"'@x\"");
  assert.equal(csvCell("normal"), '"normal"');
  assert.equal(csvCell('has "quote"'), '"has ""quote"""');
  assert.equal(csvCell(null), '""');
});
