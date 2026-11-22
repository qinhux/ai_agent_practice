import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { maxSlideCount, slideSize, type ElementBox } from "./presentations";

const run = promisify(execFile);

export type RenderedWord = { text: string; box: ElementBox };

function readPages(layout: string): RenderedWord[][] {
  // Parse Poppler's fixed XHTML output. Text is escaped, including literal tag characters.
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return Array.from(layout.matchAll(/<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g),
    ([, width, height, body]) => {
      const scaleX = slideSize.w / Number(width);
      const scaleY = slideSize.h / Number(height);
      return Array.from(body.matchAll(/<word xMin="([^"]+)" yMin="([^"]+)" xMax="([^"]+)" yMax="([^"]+)">([^<]*)<\/word>/g),
        ([, left, top, right, bottom, text]) => ({
          text: text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
            if (!entity.startsWith("#")) return entities[entity] ?? "";
            return String.fromCodePoint(entity.startsWith("#x")
              ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1)));
          }),
          box: {
            x: Number(left) * scaleX, y: Number(top) * scaleY,
            w: (Number(right) - Number(left)) * scaleX, h: (Number(bottom) - Number(top)) * scaleY,
          },
        }));
    });
}

export async function readPresentationLayout(
  bytes: Uint8Array<ArrayBuffer>, pageCount: number, signal: AbortSignal,
): Promise<RenderedWord[][]> {
  if (pageCount < 1 || pageCount > maxSlideCount) throw new Error("Unsupported layout review page count.");
  const abortSignal = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
  const directory = await mkdtemp(join(tmpdir(), "agent-ppt-layout-"));
  try {
    const input = join(directory, "slides.pptx");
    const pdf = join(directory, "slides.pdf");
    const profile = pathToFileURL(join(directory, "profile")).href;
    const options = { signal: abortSignal, maxBuffer: 4 * 1024 * 1024 };
    await writeFile(input, bytes, { signal: abortSignal });
    await run("soffice", [
      "-env:UserInstallation=" + profile, "--headless", "--convert-to", "pdf:impress_pdf_Export",
      "--outdir", directory, input,
    ], options);
    const { stdout } = await run("pdftotext", ["-enc", "UTF-8", "-bbox-layout", pdf, "-"], options);
    const pages = readPages(stdout);
    if (pages.length !== pageCount) throw new Error("Rendered page count differs from the deck.");
    if (pages.some((words) => !words.length)) throw new Error("Rendered page contains no text, including the page number.");
    return pages;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
