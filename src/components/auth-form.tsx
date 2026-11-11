"use client";

import { useState, type FormEvent } from "react";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";

export function AuthForm() {
  const [signUp, setSignUp] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email")).trim();
    const password = String(data.get("password"));
    setPending(true);
    setError(undefined);

    try {
      const result = signUp
        ? await authClient.signUp.email({ email, password, name: String(data.get("name")).trim() })
        : await authClient.signIn.email({ email, password });

      if (result.error) setError(result.error.message || "身份验证失败。");
    } catch {
      setError("无法连接身份验证服务，请稍后重试。");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="mx-auto grid min-h-[calc(100dvh-4rem)] max-w-lg place-items-center p-5">
      <section className="w-full rounded-2xl border border-border bg-card p-6 shadow-sm sm:p-9">
        <h1 className="text-2xl font-semibold tracking-tight">{signUp ? "创建账号" : "登录工作台"}</h1>
        <p className="mt-2 text-sm text-muted-foreground">使用邮箱进入 Agent 对话。</p>
        <form className="mt-7 space-y-4" onSubmit={submit}>
          {signUp && (
            <label className="block space-y-1.5 text-sm font-medium">
              <span>昵称</span>
              <Input name="name" autoComplete="name" required maxLength={80} />
            </label>
          )}
          <label className="block space-y-1.5 text-sm font-medium">
            <span>邮箱</span>
            <Input name="email" type="email" autoComplete="email" required />
          </label>
          <label className="block space-y-1.5 text-sm font-medium">
            <span>密码</span>
            <Input
              name="password"
              type="password"
              autoComplete={signUp ? "new-password" : "current-password"}
              minLength={8}
              maxLength={128}
              required
            />
          </label>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="mt-2 w-full" disabled={pending}>
            {pending ? "正在提交…" : signUp ? "注册" : "登录"}
            <ArrowRight aria-hidden="true" />
          </Button>
        </form>
        <Button
          type="button"
          variant="ghost"
          className="mt-4 w-full"
          disabled={pending}
          onClick={() => {
            setSignUp(!signUp);
            setError(undefined);
          }}
        >
          {signUp ? "已有账号？去登录" : "还没有账号？去注册"}
        </Button>
      </section>
    </main>
  );
}
