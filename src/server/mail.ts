import nodemailer from "nodemailer";
import { APIError } from "better-auth/api";

export type AuthEmail = { to: string } & (
  | { purpose: "verify"; otp: string }
  | { purpose: "reset"; url: string }
);

export function createMailTransport() {
  const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS } = process.env;
  const port = Number(SMTP_PORT);
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !process.env.MAIL_FROM ||
      !Number.isInteger(port) || port < 1 || port > 65535 ||
      !["true", "false"].includes(SMTP_SECURE ?? "")) {
    throw new Error("请在服务端配置完整的 SMTP 和 MAIL_FROM 参数。");
  }
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: SMTP_SECURE === "true",
    requireTLS: true,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

export function authEmailContent(email: AuthEmail) {
  if (email.purpose === "verify") {
    if (!/^\d{6}$/.test(email.otp)) throw new Error("Invalid verification code format");
    return {
      subject: "【Agent Practice】邮箱验证码",
      text: `你的邮箱验证码是：${email.otp}\n\n请在验证邮箱页面输入上述六位数字。验证码 5 分钟内有效，只能使用一次；重新发送后请使用最新验证码。\n\n如果不是你本人操作，请忽略此邮件。请勿向他人透露验证码。`,
      html: `<div style="font-family:Arial,sans-serif;line-height:1.8;max-width:560px;margin:auto;padding:24px;color:#172033"><h1 style="font-size:24px">验证你的邮箱</h1><p>请在 Agent Practice 的验证邮箱页面输入：</p><p style="font-size:32px;letter-spacing:8px;font-weight:bold">${email.otp}</p><p>验证码 5 分钟内有效，只能使用一次；重新发送后请使用最新验证码。</p><p style="color:#64748b">如果不是你本人操作，请忽略此邮件。请勿向他人透露验证码。</p></div>`,
    };
  }
  const { url } = email;
  const title = "重置你的密码";
  const description = "我们收到了你的密码重置请求。请点击下方链接设置新密码，链接在 30 分钟内有效，且只能使用一次。";
  const footer = "如果不是你本人操作，请忽略此邮件。请勿将链接转发给他人。";
  return {
    subject: `【Agent Practice】${title}`,
    text: `${title}\n\n${description}\n\n${url}\n\n${footer}`,
    html: `<div style="font-family:Arial,sans-serif;line-height:1.8;max-width:560px;margin:auto;padding:24px;color:#172033"><h1 style="font-size:24px">${title}</h1><p>${description}</p><p><a href="${escapeHtml(url)}">${title}</a></p><p>如果链接无法点击，请复制以下地址到浏览器：</p><p style="word-break:break-all">${escapeHtml(url)}</p><p style="color:#64748b">${footer}</p></div>`,
  };
}

export async function sendAuthEmail(email: AuthEmail) {
  try {
    const result = await createMailTransport().sendMail({
      from: process.env.MAIL_FROM,
      to: email.to,
      ...authEmailContent(email),
    });
    if (!result.accepted.length || result.rejected.length) throw new Error("Recipient rejected");
  } catch {
    // Do not expose SMTP credentials, server responses, or reset links in logs.
    throw new APIError("SERVICE_UNAVAILABLE", {
      code: "EMAIL_DELIVERY_FAILED",
      message: "邮件发送失败，请稍后重试。若已注册，可从验证邮箱页面重新发送。",
    });
  }
}
