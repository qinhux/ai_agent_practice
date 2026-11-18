"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { ArrowRight, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { useChatStore } from "@/stores/chat-store";

export type AuthMode = "login" | "register" | "forgot" | "reset" | "verify";
const copy = {
  login: ["登录工作台", "使用已验证的邮箱和密码进入 Agent 对话。", "登录"],
  register: ["创建账号", "注册后，我们会向你的邮箱发送六位数字验证码。", "注册并发送验证码"],
  forgot: ["找回密码", "输入注册邮箱，我们会发送密码重置链接。", "发送重置邮件"],
  reset: ["设置新密码", "请设置 8–128 位新密码。", "重置密码"],
  verify: ["验证邮箱", "获取邮件中的六位数字验证码，在下方填写以完成验证。", "发送验证码"],
};

function errorMessage(error: { code?: string; status?: number }) {
  if (error.status === 429) return "操作太频繁，请稍等一分钟后重试。";
  switch (error.code) {
    case "INVALID_EMAIL_OR_PASSWORD": return "邮箱或密码不正确。";
    case "INVALID_EMAIL": return "请输入有效的邮箱地址。";
    case "PASSWORD_TOO_SHORT": return "密码至少需要 8 位。";
    case "PASSWORD_TOO_LONG": return "密码不能超过 128 位。";
    case "INVALID_TOKEN":
    case "TOKEN_EXPIRED": return "链接已失效或过期，请重新申请。";
    case "EMAIL_DELIVERY_FAILED": return "邮件发送失败，请稍后重试。若注册已创建账号，可点击下方“验证邮箱”重新发送。";
    case "EMAIL_ALREADY_VERIFIED": return "该邮箱已验证，请返回登录。";
    case "EMAIL_MISMATCH": return "请输入当前登录账号的邮箱，或先退出当前账号。";
    case "INVALID_OTP": return "验证码不正确或已失效，请检查后重试，或重新获取。";
    case "OTP_EXPIRED": return "验证码已过期，请重新获取。";
    case "TOO_MANY_ATTEMPTS": return "验证码错误次数过多，请重新获取验证码。";
    default: return "操作未完成，请稍后重试。";
  }
}

export function AuthForm({
  mode = "login", initialEmail = "", token, linkError = false, verified = false,
}: {
  mode?: AuthMode; initialEmail?: string; token?: string; linkError?: boolean; verified?: boolean;
}) {
  const router = useRouter();
  const { data: session, isPending: sessionPending, error: sessionError, refetch } = authClient.useSession();
  const [enteredEmail, setEmail] = useState<string | null>(initialEmail || null);
  const email = enteredEmail ?? (mode === "verify" ? session?.user.email ?? "" : "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [cooldown, setCooldown] = useState(0);
  const [resetDone, setResetDone] = useState(false);
  const [verificationDone, setVerificationDone] = useState(false);
  const [codeError, setCodeError] = useState<string>();
  const hasPassword = ["login", "register", "reset"].includes(mode);
  const newPassword = mode === "register" || mode === "reset";
  const invalidReset = mode === "reset" && (!token || linkError);
  const [title, description, action] = copy[mode];
  const verifySessionBlocked = mode === "verify" && (sessionPending || Boolean(sessionError));
  const emailMismatch = mode === "verify" && session && email.trim().toLowerCase() !== session.user.email.toLowerCase();

  useEffect(() => {
    if (!cooldown) return;
    const timer = setTimeout(() => setCooldown((remaining) => remaining - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  async function switchAccount() {
    setPending(true);
    setError(undefined);
    setNotice(undefined);
    // Keep the intended recipient, but do not carry the current account's
    // address into the signed-out form when switching to a different account.
    const targetEmail = email.trim().toLowerCase() !== session?.user.email.toLowerCase() ? email.trim() : "";
    try {
      const result = await authClient.signOut();
      if (result.error) {
        setError("退出失败，请重试；尚未发送验证码。");
        return;
      }
      useChatStore.getState().setDraft("");
      setEmail(targetEmail);
      setNotice("已退出当前账号。请输入需要验证的邮箱，再点击重新发送。");
      router.push(`/verify-email${targetEmail ? `?email=${encodeURIComponent(targetEmail)}` : ""}`);
    } catch {
      setError("无法退出当前账号，请检查连接后重试。");
    } finally {
      setPending(false);
    }
  }

  async function verifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const otp = String(new FormData(form).get("otp") ?? "");
    setCodeError(undefined);
    if (!/^\d{6}$/.test(otp)) {
      setCodeError("请输入完整的六位数字验证码。");
      return;
    }
    if (verifySessionBlocked || emailMismatch) {
      setCodeError("请先退出当前账号，再验证其他邮箱。");
      return;
    }
    setPending(true);
    try {
      const result = await authClient.emailOtp.verifyEmail({ email: email.trim().toLowerCase(), otp });
      if (result.error) {
        setCodeError(errorMessage(result.error));
        return;
      }
      setVerificationDone(true);
      setError(undefined);
      setNotice(undefined);
      form.reset();
    } catch {
      setCodeError("无法连接身份验证服务，请稍后重试。");
    } finally {
      setPending(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const normalizedEmail = email.trim().toLowerCase();
    const password = String(data.get("password") ?? "");
    setError(undefined);
    setNotice(undefined);
    if (mode === "verify" && (verifySessionBlocked || emailMismatch)) {
      setError("请先退出当前账号，再为其他邮箱发送验证码。");
      return;
    }
    if (newPassword && password !== data.get("confirmPassword")) {
      setError("两次输入的密码不一致。");
      return;
    }
    setPending(true);
    try {
      const result = mode === "register"
        ? await authClient.signUp.email({
            email: normalizedEmail, password,
            name: String(data.get("name") ?? "").trim() || normalizedEmail.split("@")[0],
            callbackURL: "/login?verified=1",
          })
        : mode === "login"
          ? await authClient.signIn.email({ email: normalizedEmail, password })
          : mode === "forgot"
            ? await authClient.requestPasswordReset({ email: normalizedEmail, redirectTo: "/reset-password" })
            : mode === "verify"
              ? await authClient.emailOtp.sendVerificationOtp({ email: normalizedEmail, type: "email-verification" })
              : await authClient.resetPassword({ newPassword: password, token });
      if (result.error) {
        if (result.error.code === "EMAIL_NOT_VERIFIED") {
          router.push(`/verify-email?email=${encodeURIComponent(normalizedEmail)}`);
          return;
        }
        setError(errorMessage(result.error));
        return;
      }
      if (mode === "login") {
        router.push("/");
        router.refresh();
      } else if (mode === "register") {
        router.push(`/verify-email?email=${encodeURIComponent(normalizedEmail)}&registered=1`);
      } else if (mode === "reset") {
        setResetDone(true);
      } else {
        setCooldown(60);
        setNotice(mode === "forgot"
          ? "如果该邮箱已注册，重置邮件将发送到你的邮箱，请检查收件箱和垃圾邮件。链接在 30 分钟内有效。"
          : "如果该邮箱已注册，验证码将发送到你的邮箱，请检查收件箱和垃圾邮件。验证码 5 分钟内有效，请使用最新收到的一组数字。");
      }
    } catch {
      setError("无法连接身份验证服务，请稍后重试。");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="mx-auto grid min-h-[calc(100dvh-4rem)] max-w-lg place-items-center p-5">
      <section className="w-full rounded-2xl border border-border bg-card p-6 shadow-sm sm:p-9">
        <Mail aria-hidden="true" className="mb-5 size-10 rounded-xl bg-primary/10 p-2 text-primary" />
        <h1 className="text-2xl font-semibold tracking-tight">{verificationDone ? "邮箱验证成功" : resetDone ? "密码已重置" : title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{verificationDone ? "现在可以使用邮箱和密码登录工作台。" : resetDone ? "旧会话已退出，请使用新密码重新登录。" : description}</p>
        {mode === "verify" && !verificationDone && (
          <div className="mt-4 space-y-3 rounded-lg border border-border p-3 text-sm">
            {sessionPending ? <p role="status">正在检查当前登录账号…</p>
              : sessionError ? <><p role="alert">无法检查当前账号，请重试。</p><Button variant="outline" type="button" onClick={() => void refetch()}>重新检查</Button></>
              : session ? <>
                <p className="break-all">当前登录账号：<strong>{session.user.email}</strong></p>
                <p className="text-muted-foreground">{session.user.emailVerified ? "该账号的邮箱已经验证。验证其他邮箱前，请先退出。" : "当前只能向这个账号发送验证码。验证其他邮箱前，请先退出。"}</p>
                <Button type="button" variant="outline" className="w-full" disabled={pending} onClick={() => void switchAccount()}>退出当前账号并切换邮箱</Button>
              </> : <p>当前未登录，可以为注册邮箱重新发送验证码。</p>}
          </div>
        )}
        {verified && !linkError && <p role="status" className="mt-4 rounded-lg bg-primary/10 p-3 text-sm">邮箱验证成功，请登录。</p>}
        {linkError && <p role="alert" className="mt-4 text-sm text-destructive">链接已失效或过期，请重新申请{mode === "reset" ? "密码重置" : "邮箱验证"}邮件。</p>}
        {invalidReset && !linkError && <p role="alert" className="mt-4 text-sm text-destructive">缺少重置链接，请先申请密码重置邮件。</p>}
        {!invalidReset && !resetDone && !verificationDone && (
          <form className="mt-7 space-y-4" onSubmit={submit}>
            <fieldset disabled={pending || verifySessionBlocked} className="space-y-4">
              {mode === "register" && (
                <label className="block space-y-1.5 text-sm font-medium">
                  <span>昵称（选填）</span>
                  <Input name="name" autoComplete="nickname" maxLength={80} />
                </label>
              )}
              {mode !== "reset" && (
                <label className="block space-y-1.5 text-sm font-medium">
                  <span>邮箱</span>
                  <Input name="email" type="email" autoComplete="email" value={email}
                    onChange={(event) => { setEmail(event.target.value); setCodeError(undefined); setNotice(undefined); }} required maxLength={254} />
                </label>
              )}
              {hasPassword && (
                <label className="block space-y-1.5 text-sm font-medium">
                  <span>{mode === "reset" ? "新密码" : "密码"}</span>
                  <Input name="password" type="password" autoComplete={newPassword ? "new-password" : "current-password"}
                    minLength={8} maxLength={128} required />
                </label>
              )}
              {newPassword && (
                <label className="block space-y-1.5 text-sm font-medium">
                  <span>确认密码</span>
                  <Input name="confirmPassword" type="password" autoComplete="new-password" minLength={8} maxLength={128} required />
                </label>
              )}
              {mode === "login" && <div className="text-right text-sm"><Link className="text-primary hover:underline" href="/forgot-password">忘记密码？</Link></div>}
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
              {notice && <p role="status" className="rounded-lg bg-primary/10 p-3 text-sm leading-relaxed">{notice}</p>}
              {emailMismatch && <p role="alert" className="text-sm text-destructive">此邮箱与当前账号不同，请先点击上方“退出当前账号并切换邮箱”。尚未发送验证码。</p>}
              <Button type="submit" className="w-full" disabled={pending || cooldown > 0 || verifySessionBlocked || Boolean(emailMismatch) || (mode === "verify" && Boolean(session?.user.emailVerified))}>
                {pending ? "正在提交…" : cooldown > 0 ? `${cooldown} 秒后可重新发送` : action}
                <ArrowRight aria-hidden="true" />
              </Button>
            </fieldset>
          </form>
        )}
        {mode === "verify" && !verificationDone && (
          <form onSubmit={verifyCode} className="mt-6 space-y-4 border-t border-border pt-6">
            <label className="block space-y-1.5 text-sm font-medium">
              <span>六位数字验证码</span>
              <Input key={email.trim().toLowerCase()} name="otp" type="text" inputMode="numeric" autoComplete="one-time-code"
                pattern="[0-9]{6}" minLength={6} maxLength={6} required placeholder="000000"
                className="text-center text-xl tracking-[0.4em]" disabled={pending || verifySessionBlocked}
                aria-describedby="otp-help" />
            </label>
            <p id="otp-help" className="text-xs text-muted-foreground">验证码 5 分钟内有效，最多允许 5 次错误尝试。重新发送后请使用最新验证码。</p>
            {codeError && <p role="alert" className="text-sm text-destructive">{codeError}</p>}
            <Button type="submit" className="w-full" disabled={pending || verifySessionBlocked || !email.trim() || Boolean(emailMismatch) || Boolean(session?.user.emailVerified)}>
              {pending ? "正在提交…" : "验证邮箱"}
            </Button>
          </form>
        )}
        <nav aria-label="账号操作" className="mt-5 flex flex-wrap justify-center gap-x-5 gap-y-3 text-sm text-primary">
          {mode === "login" ? <Link className="hover:underline" href="/register">还没有账号？去注册</Link> : <Link className="hover:underline" href="/login">返回登录</Link>}
          {["login", "register"].includes(mode) && <Link className="hover:underline" href={`/verify-email${email ? `?email=${encodeURIComponent(email.trim())}` : ""}`}>验证邮箱</Link>}
          {mode === "reset" && !resetDone && <Link className="hover:underline" href="/forgot-password">重新申请重置邮件</Link>}
        </nav>
        {mode === "forgot" && <p className="mt-5 text-xs leading-relaxed text-muted-foreground">本地运行期间，请在运行项目的这台电脑上打开邮件链接。</p>}
        {mode === "verify" && !verificationDone && <p className="mt-5 text-xs leading-relaxed text-muted-foreground">可以在手机上查看邮件，再回到此页面输入验证码。</p>}
        {mode === "verify" && <p className="mt-2 text-xs leading-relaxed text-muted-foreground">已有账号可直接返回登录；忘记密码请前往登录页找回。</p>}
      </section>
    </main>
  );
}
