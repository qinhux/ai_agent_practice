import type { BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { emailOTP } from "better-auth/plugins/email-otp";
import { sendAuthEmail } from "./mail";
import { deliverAuthEmail } from "./auth-email-delivery";

export function emailAuthOptions(sendEmail = sendAuthEmail) {
  return {
    plugins: [emailOTP({
      otpLength: 6,
      expiresIn: 5 * 60,
      allowedAttempts: 5,
      storeOTP: "hashed",
      resendStrategy: "rotate",
      disableSignUp: true,
      overrideDefaultEmailVerification: true,
      sendVerificationOTP: async ({ email, otp, type }) => {
        if (type !== "email-verification") throw new APIError("BAD_REQUEST", { code: "INVALID_OTP_TYPE", message: "仅支持注册邮箱验证码。" });
        await deliverAuthEmail(sendEmail, { to: email, otp, purpose: "verify" });
      },
    })],
    // Enable only mailbox verification, keeping password sign-in and the
    // existing password-reset flow as the account entry points.
    disabledPaths: [
      "/verify-email", "/send-verification-email", "/sign-in/email-otp",
      "/email-otp/check-verification-otp", "/email-otp/request-password-reset",
      "/forget-password/email-otp", "/email-otp/reset-password",
      "/email-otp/request-email-change", "/email-otp/change-email",
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (!["/email-otp/send-verification-otp", "/email-otp/verify-email"].includes(ctx.path)) return;
        if (ctx.path === "/email-otp/send-verification-otp" && ctx.body?.type !== "email-verification") {
          throw new APIError("BAD_REQUEST", { code: "INVALID_OTP_TYPE", message: "仅支持注册邮箱验证码。" });
        }
        const session = await getSessionFromCtx(ctx);
        if (session && session.user.email.toLowerCase() !== String(ctx.body?.email).toLowerCase()) {
          throw new APIError("BAD_REQUEST", { code: "EMAIL_MISMATCH", message: "请先退出当前账号，再验证其他邮箱。" });
        }
        if (session?.user.emailVerified && ctx.path === "/email-otp/send-verification-otp") {
          throw new APIError("BAD_REQUEST", { code: "EMAIL_ALREADY_VERIFIED", message: "该邮箱已经验证。" });
        }
        if (ctx.path === "/email-otp/send-verification-otp") {
          // The verification identifier is indexed, not unique. Clear earlier
          // rows so rapid resends cannot select an older row with the same
          // millisecond timestamp as the new OTP.
          await ctx.context.adapter.deleteMany({
            model: "verification",
            where: [{ field: "identifier", value: `email-verification-otp-${String(ctx.body?.email).toLowerCase()}` }],
          });
        }
      }),
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: 30 * 60,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await deliverAuthEmail(sendEmail, { to: user.email, url, purpose: "reset" });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: false,
      autoSignInAfterVerification: false,
    },
    rateLimit: {
      enabled: true,
      storage: "memory",
      customRules: {
        "/sign-up/email": { window: 60, max: 5 },
        "/sign-in/email": { window: 60, max: 10 },
        "/email-otp/send-verification-otp": { window: 60, max: 1 },
        "/email-otp/verify-email": { window: 60, max: 10 },
        "/request-password-reset": { window: 60, max: 3 },
        "/reset-password": { window: 60, max: 5 },
      },
    },
  } satisfies BetterAuthOptions;
}
