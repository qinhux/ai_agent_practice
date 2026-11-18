import { z } from "zod";
import { getAuth } from "@/server/auth";
import { getPrisma } from "@/server/db";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: RouteContext<"/api/images/[id]">) {
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session) return new Response("请先登录。", { status: 401 });
  if (!session.user.emailVerified) return new Response("请先验证邮箱。", { status: 403 });

  const { id } = await params;
  const image = z.uuid().safeParse(id).success
    ? await getPrisma().generatedImage.findUnique({
        where: { id, userId: session.user.id },
        select: { bytes: true },
      })
    : null;
  if (!image) return new Response("找不到这张图片。", { status: 404 });

  return new Response(image.bytes, {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
