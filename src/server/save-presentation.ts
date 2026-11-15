import { getPrisma } from "./db";
import { getSlideColors, renderPresentation, type PresentationImage, type PresentationSource } from "./presentations";

export async function savePresentation(
  userId: string,
  // 可编辑的 PPT 源数据，包括标题、配色、每页的版式、文字和文字样式。
  source: PresentationSource,
  // 按幻灯片 slideId 索引的图片集合。每项包含图片字节、在页面上的位置和尺寸，以及是否为备用图。
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
      images: { create: Array.from(images, ([slideId, image]) => ({ slideId, ...image })) },
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
    fallbackImageCount: Array.from(images.values()).filter((image) => image.fallback).length,
  };
}
