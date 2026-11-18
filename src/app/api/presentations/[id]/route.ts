import { z } from "zod";
import { getAuth } from "@/server/auth";
import { getPrisma } from "@/server/db";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: RouteContext<"/api/presentations/[id]">) {
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session) {
    return new Response("请先登录。", { status: 401 });
  }
  if (!session.user.emailVerified) {
    return new Response("请先验证邮箱。", { status: 403 });
  }

  const { id } = await params;
  const presentation = z.uuid().safeParse(id).success
    ? await getPrisma().presentation.findUnique({
        where: { id, userId: session.user.id },
        select: { title: true, bytes: true },
      })
    : null;
  if (!presentation) {
    return new Response("找不到这份 PPT。", { status: 404 });
  }

  const safeTitle = presentation.title.replace(/[<>:"/\\|?*]/g, "-");
  const fileName = encodeURIComponent(`${safeTitle}.pptx`).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  return new Response(presentation.bytes, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "Content-Disposition": `attachment; filename="presentation.pptx"; filename*=UTF-8''${fileName}`,
      "Cache-Control": "private, no-store",
    },
  });
}
