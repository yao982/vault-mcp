import assert from "node:assert/strict";
import test from "node:test";
import { parseAndChunkMarkdown } from "../src/parser/markdown.js";

test("nested-length code fences, tilde fences and math preserve complete blocks", () => {
  const blocks = [
    "````md\n```js\n# not a heading\n```\n\ninside\n````",
    "~~~python\n# not a heading\n\ninside\n~~~",
    "$$\na=b+c\n\n# still formula\n$$",
  ];
  for (const block of blocks) {
    const source = `# Parent\n\n${block}\n\n## Child\nlast line`;
    const chunks = parseAndChunkMarkdown(source, 5);
    assert.ok(chunks.some(chunk => chunk.content.includes(block)));
    assert.ok(chunks.every(chunk => !chunk.headingPath.includes("not a heading")));
    assert.equal(chunks.at(-1)?.headingPath, "Parent > Child");
    for (const chunk of chunks) {
      assert.equal(source.split("\n").slice(chunk.startLine - 1, chunk.endLine).join("\n").trim(), chunk.content);
    }
  }
});

test("a long unbroken paragraph is preserved rather than silently shortened", () => {
  const body = "液压轨迹跟踪".repeat(400) + "唯一尾部标记";
  const chunks = parseAndChunkMarkdown(body);
  assert.equal(chunks.map(c => c.content).join(""), body);
});
