import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { memoryAdapter } from "better-auth/adapters/memory";
import nodemailer from "nodemailer";
import { emailAuthOptions } from "../src/server/email-auth-options.ts";
import { withEmailDelivery } from "../src/server/auth-email-delivery.ts";
import { authEmailContent, sendAuthEmail } from "../src/server/mail.ts";

const baseURL = "http://localhost:3000";
const password = "original-password-123";
function fixture({ failMail = false, rateLimit = false } = {}) {
  const messages = [];
  const db = { user: [], account: [], session: [], verification: [] };
  const auth = betterAuth({
    baseURL, secret: "test-only-secret-with-at-least-thirty-two-characters",
    database: memoryAdapter(db),
    ...emailAuthOptions(async (email) => {
      if (failMail) throw new APIError("SERVICE_UNAVAILABLE", { code: "EMAIL_DELIVERY_FAILED", message: "邮件发送失败" });
      messages.push(email);
    }),
    rateLimit: { ...emailAuthOptions().rateLimit, enabled: rateLimit },
    logger: { disabled: true },
  });
  const email = `${randomUUID()}@example.com`;
  async function request(path, body, cookie) {
    if (path === "/email-otp/send-verification-otp" && body) body = { type: "email-verification", ...body };
    return withEmailDelivery(() => auth.handler(new Request(new URL(`/api/auth${path}`, baseURL), {
      method: body ? "POST" : "GET",
      headers: { origin: baseURL, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })));
  }
  async function signup() {
    return request("/sign-up/email", { email, password, name: "测试用户", callbackURL: "/login?verified=1" });
  }
  async function verify() {
    const otp = messages.filter((message) => message.purpose === "verify").at(-1).otp;
    return request("/email-otp/verify-email", { email, otp });
  }
  return { auth, db, email, messages, request, signup, verify };
}
function cookieOf(response) {
  return response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
}

test("registration sends verification, blocks sign-in until verification, and preserves the user ID", async () => {
  const f = fixture();
  const signup = await f.signup();
  assert.equal(signup.status, 200);
  const userId = (await signup.json()).user.id;
  assert.equal(cookieOf(signup), "");
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].to, f.email);
  assert.match(f.messages[0].otp, /^[0-9]{6}$/);
  const storedOTP = f.db.verification.find((row) => row.identifier === `email-verification-otp-${f.email}`);
  assert.ok(storedOTP);
  assert.notEqual(storedOTP.value.split(":")[0], f.messages[0].otp);
  assert.ok(storedOTP.expiresAt.getTime() - Date.now() <= 300_000);
  const blocked = await f.request("/sign-in/email", { email: f.email, password });
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).code, "EMAIL_NOT_VERIFIED");
  const verified = await f.verify();
  assert.equal(verified.status, 200);
  assert.equal((await verified.json()).token, null);
  const signedIn = await f.request("/sign-in/email", { email: f.email, password });
  assert.equal(signedIn.status, 200);
  assert.equal((await signedIn.json()).user.id, userId);
  const session = await f.request("/get-session", undefined, cookieOf(signedIn));
  assert.equal((await session.json()).user.emailVerified, true);
});

test("verification can be resent for an existing unverified account, and incorrect codes are rejected", async () => {
  const f = fixture();
  await f.signup();
  const resend = await f.request("/email-otp/send-verification-otp", { email: f.email, callbackURL: "/login?verified=1" });
  assert.equal(resend.status, 200);
  assert.equal(f.messages.length, 2);
  const latest = f.messages.at(-1).otp;
  const wrong = latest === "000000" ? "999999" : "000000";
  const bad = await f.request("/email-otp/verify-email", { email: f.email, otp: wrong });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, "INVALID_OTP");
  assert.equal(f.db.user[0].emailVerified, false);
});

test("a different signed-in account must sign out before resending to the intended recipient", async () => {
  const f = fixture();
  await f.signup();
  await f.verify();
  const signedIn = await f.request("/sign-in/email", { email: f.email, password });
  const cookie = cookieOf(signedIn);
  const otherEmail = `${randomUUID()}@example.com`;
  await f.request("/sign-up/email", { email: otherEmail, password, name: "另一账号" });
  const before = f.messages.length;
  const rejected = await f.request("/email-otp/send-verification-otp", { email: otherEmail }, cookie);
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).code, "EMAIL_MISMATCH");
  assert.equal(f.messages.length, before);
  const signOut = await f.request("/sign-out", {}, cookie);
  assert.equal(signOut.status, 200);
  assert.equal(await (await f.request("/get-session", undefined, cookie)).json(), null);
  const resent = await f.request("/email-otp/send-verification-otp", { email: otherEmail, callbackURL: "/login?verified=1" });
  assert.equal(resent.status, 200);
  assert.equal(f.messages.length, before + 1);
  assert.equal(f.messages.at(-1).to, otherEmail);
  assert.equal(f.messages.at(-1).purpose, "verify");
});

test("password reset is single-use, changes the password, and revokes every existing session", async () => {
  const f = fixture();
  await f.signup();
  await f.verify();
  const oldSession = await f.request("/sign-in/email", { email: f.email, password });
  const cookie = cookieOf(oldSession);
  assert.ok(cookie);
  const requested = await f.request("/request-password-reset", { email: f.email, redirectTo: "/reset-password" });
  assert.equal(requested.status, 200);
  const url = new URL(f.messages.find((message) => message.purpose === "reset").url);
  const callback = await f.request(url.pathname.replace("/api/auth", "") + url.search);
  const destination = new URL(callback.headers.get("location"));
  assert.equal(destination.pathname, "/reset-password");
  const token = destination.searchParams.get("token");
  assert.ok(token);
  const reset = { token, newPassword: "replacement-password-456" };
  assert.equal((await f.request("/reset-password", reset)).status, 200);
  assert.equal(await (await f.request("/get-session", undefined, cookie)).json(), null);
  assert.equal((await f.request("/sign-in/email", { email: f.email, password })).status, 401);
  assert.equal((await f.request("/sign-in/email", { email: f.email, password: reset.newPassword })).status, 200);
  assert.equal((await f.request("/reset-password", reset)).status, 400);
});

test("unknown addresses get the same reset response and are not sent mail", async () => {
  const f = fixture();
  await f.signup();
  const known = await f.request("/request-password-reset", { email: f.email, redirectTo: "/reset-password" });
  const count = f.messages.length;
  const unknown = await f.request("/request-password-reset", { email: "unknown@example.com", redirectTo: "/reset-password" });
  assert.equal(known.status, unknown.status);
  assert.deepEqual(await known.json(), await unknown.json());
  assert.equal(f.messages.length, count);
});

test("expired reset tokens and untrusted redirect destinations are rejected", async () => {
  const f = fixture();
  await f.signup();
  await f.request("/request-password-reset", { email: f.email, redirectTo: "/reset-password" });
  const row = f.db.verification.find((value) => value.identifier.startsWith("reset-password:"));
  row.expiresAt = new Date(Date.now() - 1000);
  const reset = await f.request("/reset-password", { token: row.identifier.slice("reset-password:".length), newPassword: "new-password-123" });
  assert.equal(reset.status, 400);
  assert.equal((await reset.json()).code, "INVALID_TOKEN");
  const unsafe = await f.request("/request-password-reset", { email: f.email, redirectTo: "https://attacker.example/reset" });
  assert.equal(unsafe.status, 403);
});

test("mail delivery failure is returned as an actionable error instead of success", async () => {
  const f = fixture({ failMail: true });
  const signup = await f.signup();
  assert.equal(signup.status, 503);
  assert.equal((await signup.json()).code, "EMAIL_DELIVERY_FAILED");
  const reset = await f.request("/request-password-reset", { email: f.email, redirectTo: "/reset-password" });
  assert.equal(reset.status, 503);
  assert.equal((await reset.json()).code, "EMAIL_DELIVERY_FAILED");
  const resend = await f.request("/email-otp/send-verification-otp", { email: f.email });
  assert.equal(resend.status, 503);
});

test("mail delivery state stays isolated between concurrent requests", async () => {
  const good = fixture();
  const bad = fixture({ failMail: true });
  const [accepted, failed] = await Promise.all([good.signup(), bad.signup()]);
  assert.equal(accepted.status, 200);
  assert.equal(failed.status, 503);
});

test("mail requests are rate limited even in development", async () => {
  const f = fixture({ rateLimit: true });
  for (let i = 0; i < 3; i++) {
    assert.equal((await f.request("/request-password-reset", { email: "unknown@example.com" })).status, 200);
  }
  const limited = await f.request("/request-password-reset", { email: "unknown@example.com" });
  assert.equal(limited.status, 429);
});

test("email OTP expires and cannot verify a different address", async () => {
  const f = fixture();
  await f.signup();
  const otp = f.messages[0].otp;
  const wrongMailbox = await f.request("/email-otp/verify-email", { email: "other@example.com", otp });
  assert.equal(wrongMailbox.status, 400);
  for (const row of f.db.verification) row.expiresAt = new Date(Date.now() - 1000);
  const expired = await f.verify();
  assert.equal(expired.status, 400);
  assert.equal((await expired.json()).code, "OTP_EXPIRED");
  assert.equal(f.db.user[0].emailVerified, false);
});

test("the newest email OTP is single-use and replaces the earlier code", async () => {
  const f = fixture();
  await f.signup();
  const original = f.messages[0].otp;
  await f.request("/email-otp/send-verification-otp", { email: f.email });
  const latest = f.messages.at(-1).otp;
  // Two independently generated six-digit codes can legitimately coincide.
  if (original !== latest) {
    const old = await f.request("/email-otp/verify-email", { email: f.email, otp: original });
    assert.equal(old.status, 400);
  }
  assert.equal((await f.verify()).status, 200);
  assert.equal((await f.verify()).status, 400);
});

test("five incorrect guesses lock the OTP until a new code is requested", async () => {
  const f = fixture();
  await f.signup();
  const wrong = f.messages[0].otp === "000000" ? "999999" : "000000";
  for (let i = 0; i < 5; i++) {
    const result = await f.request("/email-otp/verify-email", { email: f.email, otp: wrong });
    assert.equal(result.status, 400);
  }
  const locked = await f.verify();
  assert.equal(locked.status, 403);
  assert.equal((await locked.json()).code, "TOO_MANY_ATTEMPTS");
  assert.equal(f.db.user[0].emailVerified, false);
  await f.request("/email-otp/send-verification-otp", { email: f.email });
  assert.equal((await f.verify()).status, 200);
});

test("OTP resend is limited to once per minute and extra OTP entry points stay disabled", async () => {
  const f = fixture({ rateLimit: true });
  const first = await f.request("/email-otp/send-verification-otp", { email: "unknown@example.com" });
  assert.equal(first.status, 200);
  const second = await f.request("/email-otp/send-verification-otp", { email: "unknown@example.com" });
  assert.equal(second.status, 429);
  for (const path of ["/send-verification-email", "/sign-in/email-otp", "/email-otp/request-password-reset", "/email-otp/check-verification-otp"]) {
    assert.equal((await f.request(path, { email: f.email, otp: "123456" })).status, 404);
  }
  const noLink = await f.request("/verify-email?token=old-link");
  assert.equal(noLink.status, 404);
});

test("email templates escape links, supply plain text, and do not expose SMTP errors", async (t) => {
  const url = 'https://example.com/?a=1&b="<test>"';
  const content = authEmailContent({ to: "test@example.com", url, purpose: "reset" });
  assert.match(content.text, /30 分钟/);
  assert.ok(content.text.includes(url));
  assert.ok(!content.html.includes('<test>'));
  assert.match(content.html, /&amp;b=&quot;&lt;test&gt;&quot;/);
  const verification = authEmailContent({ to: "test@example.com", purpose: "verify", otp: "012345" });
  assert.match(verification.text, /012345/);
  assert.match(verification.html, /012345/);
  assert.match(verification.text, /5 分钟/);
  assert.ok(!verification.html.includes("href="));
  // Prevent real delivery even if the caller exports SMTP environment variables.
  t.mock.method(nodemailer, "createTransport", () => { throw new Error("SMTP_PASS=private-test-credential"); });
  await assert.rejects(sendAuthEmail({ to: "test@example.com", otp: "012345", purpose: "verify" }), (error) => {
    assert.equal(error.statusCode, 503);
    assert.equal(error.body.code, "EMAIL_DELIVERY_FAILED");
    assert.ok(!error.message.includes("SMTP_PASS"));
    return true;
  });
});
