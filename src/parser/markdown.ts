export interface MarkdownChunk {
  headingPath: string; // 标题面包屑路径，例如 "Transformer > 3.2 Multi-Head Attention"
  startLine: number;   // 切片起始行号 (1-based)
  endLine: number;     // 切片结束行号
  content: string;     // 切片正文（包含 LaTeX 公式与代码块）
}

/**
 * 大纲感知 Markdown 智能分块器 (Outline-aware Markdown Chunker)
 * 
 * 核心特性：
 * 1. 标题感知：按 # / ## / ### 大纲层级维护面包屑导航。
 * 2. 公式保护：遇到 $$...$$ 跨行 LaTeX 公式绝不截断。
 * 3. 代码保护：遇到 ```...``` 代码块绝不截断。
 * 4. 合理分块：目标块大小控制在 500~1000 字符之间，尽量在段落空行处切分。
 */
export function parseAndChunkMarkdown(rawText: string, targetChunkSize = 800): MarkdownChunk[] {
  const lines = rawText.split(/\r?\n/);
  const chunks: MarkdownChunk[] = [];

  // 当前大纲标题栈，例如 [ { level: 1, title: "Transformer" }, { level: 2, title: "Attention" } ]
  const headingStack: { level: number; title: string }[] = [];

  function getHeadingPath(): string {
    if (headingStack.length === 0) return "Root";
    return headingStack.map((h) => h.title).join(" > ");
  }

  let codeFence: { marker: string; length: number } | null = null;
  let inMathBlock = false;

  let currentChunkLines: string[] = [];
  let currentLength = 0;
  let currentStartLine = 1;

  function flushChunk(endLine: number) {
    const text = currentChunkLines.join("\n").trim();
    if (text.length > 0) {
      chunks.push({
        headingPath: getHeadingPath(),
        startLine: currentStartLine,
        endLine: endLine,
        content: text
      });
    }
    currentChunkLines = [];
    currentLength = 0;
    currentStartLine = endLine + 1;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    // A fence closes only with the same marker and at least the opening length.
    const fence = !inMathBlock ? line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/) : null;
    if (fence && (!codeFence || (fence[1][0] === codeFence.marker &&
        fence[1].length >= codeFence.length && fence[2].trim() === ""))) {
      codeFence = codeFence ? null : { marker: fence[1][0], length: fence[1].length };
      currentChunkLines.push(line);
      currentLength += line.length + 1;
      continue;
    }

    // 2. 检查多行数学公式块标记 $$
    if (!codeFence && trimmed.startsWith("$$")) {
      // 如果一行里同时包含两个 $$（如 $$ E = mc^2 $$），则不算跨行
      if (trimmed.length > 2 && trimmed.endsWith("$$")) {
        // 单行独立公式
      } else {
        inMathBlock = !inMathBlock;
      }
      currentChunkLines.push(line);
      currentLength += line.length + 1;
      continue;
    }

    // 3. 在非代码块、非公式块状态下，检查大纲标题 (#, ##, ###)
    if (!codeFence && !inMathBlock) {
      const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        const title = headingMatch[2].trim();

        // 遇到新标题时，先将之前的内容作为一个 chunk 保存
        if (currentChunkLines.length > 0) {
          flushChunk(lineNum - 1);
        }

        // 更新标题栈：弹出层级 >= 当前级别的旧标题
        while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
          headingStack.pop();
        }
        headingStack.push({ level, title });

        currentStartLine = lineNum;
        currentChunkLines.push(line);
        currentLength += line.length + 1;
        continue;
      }
    }

    currentChunkLines.push(line);
    currentLength += line.length + 1;

    // 4. 如果当前累积的文本长度超过目标大小，且不在代码块或公式块内部，可在段落空行处进行切分
    if (!codeFence && !inMathBlock && currentLength >= targetChunkSize && trimmed === "") {
      flushChunk(lineNum);
    }
  }

  // 收尾：保存剩余内容
  if (currentChunkLines.length > 0) {
    flushChunk(lines.length);
  }

  return chunks;
}
