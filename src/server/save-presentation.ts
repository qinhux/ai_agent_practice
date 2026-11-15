import { getPrisma } from "./db";
import {
  elementBoxSchema,
  getSlideColors,
  presentationSourceSchema,
  renderPresentation,
  type PresentationImage,
  type PresentationSource,
} from "./presentations";

export function readPresentationSource(record: { source: unknown } | null): { source: PresentationSource } | { error: string } {
  if (!record) return { error: "找不到这份 PPT。请指定当前对话中的 PPT。" };
  const parsed = presentationSourceSchema.safeParse(record.source);
  if (!parsed.success) return { error: "这份 PPT 没有可编辑的逐页数据。请选用近期生成的 PPT。" };
  return { source: parsed.data };
}

export async function loadPresentationForEdit(userId: string, presentationId: string) {
  const original = await getPrisma().presentation.findUnique({
    where: { id: presentationId, userId },
    select: {
      source: true,
      images: { select: { elementId: true, slideId: true, bytes: true, box: true, fallback: true } },
    },
  });
  const result = readPresentationSource(original);
  if ("error" in result) return result;
  const images = new Map((original?.images ?? []).map(({ elementId, box, ...image }) =>
    [elementId, { ...image, box: elementBoxSchema.parse(box) }] as const));
  return { source: result.source, images };
}

export async function savePresentation(
  userId: string,
  // 可编辑的 PPT 源数据，包括标题、配色、每页的版式、文字和文字样式。
  source: PresentationSource,
  // 按元素 ID 索引的图片集合。
  images: ReadonlyMap<string, PresentationImage>,
  // 请求的取消信号。函数在渲染完成后、写入数据库前检查它。
  abortSignal?: AbortSignal,
  // 本次修改所基于的 PPT 版本 ID。首次生成时省略，修改已有 PPT 时传入。
  parentId?: string,
) {
  const bytes = await renderPresentation(source, getSlideColors(source), images);
  abortSignal?.throwIfAborted();
  const presentation = await getPrisma().presentation.create({
    data: {
      userId,
      parentId,
      title: source.title,
      bytes,
      source,
      images: { create: Array.from(images, ([elementId, image]) => ({ elementId, ...image })) },
    },
    select: { id: true, title: true },
  });

  return {
    // id：本次保存的新记录 ID，聊天界面用它构造下载链接
    // 保存后的 PPT 标题
    ...presentation,
    // PPT 的总页数
    slideCount: source.slides.length,
    // 使用备用图片的数量
    fallbackImageCount: new Set(Array.from(images.values()).filter((image) => image.fallback)
      .map((image) => image.slideId)).size,
  };
}
