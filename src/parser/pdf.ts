import { parseAndChunkMarkdown, type MarkdownChunk } from "./markdown.js";

export const PDF_PARSE_VERSION = "pdfjs-6.3.289-text-v1";

export interface PdfPageText {
  page: number;
  text: string;
}

export interface PdfExtractionResult {
  status: "ready" | "empty";
  pageCount: number;
  extractedPageCount: number;
  coverage: number;
  pages: PdfPageText[];
}

export class PdfExtractionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PdfExtractionError";
  }
}

/**
 * Extract page text in PDF.js reading order. This deliberately does not claim
 * to reconstruct tables, columns, or other complex page layout.
 */
export async function extractPdfPages(source: Uint8Array): Promise<PdfExtractionResult> {
  if (source.byteLength === 0) throw new PdfExtractionError("PDF is empty.");
  if (source.byteLength < 8 || new TextDecoder("ascii").decode(source.subarray(0, 5)) !== "%PDF-") {
    throw new PdfExtractionError("File does not have a valid PDF header.");
  }

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: Uint8Array.from(source),
    useSystemFonts: true,
    verbosity: 0,
  });

  try {
    const document = await loadingTask.promise;
    const pages: PdfPageText[] = [];
    let extractedPageCount = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const items = textContent.items as Array<{ str?: string; hasEOL?: boolean }>;
      let text = "";
      for (const item of items) {
        if (typeof item.str !== "string") continue;
        text += item.str;
        text += item.hasEOL ? "\n" : " ";
      }
      text = text.replace(/[ \t]+\n/g, "\n").trim();
      if (text.length > 0) extractedPageCount++;
      pages.push({ page: pageNumber, text });
      page.cleanup();
    }

    if (document.numPages < 1) throw new PdfExtractionError("PDF contains no pages.");
    const coverage = extractedPageCount / document.numPages;
    return {
      status: extractedPageCount > 0 ? "ready" : "empty",
      pageCount: document.numPages,
      extractedPageCount,
      coverage,
      pages,
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const message = error instanceof Error ? error.message : String(error);
    if (/password|encrypted/i.test(name) || /password required|password is required/i.test(message)) {
      throw new PdfExtractionError(`PDF is password-protected and cannot be indexed: ${message}`, { cause: error });
    }
    if (error instanceof PdfExtractionError) throw error;
    throw new PdfExtractionError(`PDF text extraction failed: ${message}`, { cause: error });
  } finally {
    await loadingTask.destroy();
  }
}

/** Chunk each page independently so line and citation coordinates stay local. */
export function chunkPdfPage(page: PdfPageText, targetChunkSize = 800): MarkdownChunk[] {
  if (!Number.isSafeInteger(page.page) || page.page < 1) throw new RangeError("PDF page number must be a positive integer.");
  if (!page.text.trim()) return [];
  return parseAndChunkMarkdown(page.text, targetChunkSize).map((chunk) => ({
    ...chunk,
    headingPath: chunk.headingPath === "Root" ? `PDF page ${page.page}` : chunk.headingPath,
    pageStart: page.page,
    pageEnd: page.page,
  }));
}
