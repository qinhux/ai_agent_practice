import { AsyncLocalStorage } from "node:async_hooks";
import { APIError } from "better-auth/api";
import type { AuthEmail } from "./mail";

const delivery = new AsyncLocalStorage<{ failed: boolean }>();

export async function deliverAuthEmail(sendEmail: (email: AuthEmail) => Promise<void>, email: AuthEmail) {
  try {
    await sendEmail(email);
  } catch {
    const current = delivery.getStore();
    if (current) current.failed = true;
    throw new APIError("SERVICE_UNAVAILABLE", {
      code: "EMAIL_DELIVERY_FAILED",
      message: "邮件发送失败，请稍后重试。",
    });
  }
}

// Better Auth treats some email callbacks as background work and catches their
// errors. Track delivery per request so the HTTP client can offer a retry.
export function withEmailDelivery(handler: () => Promise<Response>) {
  return delivery.run({ failed: false }, async () => {
    const response = await handler();
    if (!delivery.getStore()?.failed) return response;
    return Response.json({
      code: "EMAIL_DELIVERY_FAILED",
      message: "邮件发送失败，请稍后重试。",
    }, { status: 503 });
  });
}
