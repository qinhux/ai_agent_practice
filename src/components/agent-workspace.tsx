"use client";

import { useChat } from "@ai-sdk/react";
import { ArrowUp, Bot, Clock3, LogOut, Plus, Square } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { AuthForm } from "@/components/auth-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
import type { AgentMessage } from "@/server/agent";
import { useChatStore } from "@/stores/chat-store";

const examplePrompt = "现在上海几点？请查询当前时间。";

function Chat() {
  const { messages, sendMessage, status, stop, error, clearError, setMessages } =
    useChat<AgentMessage>();
  const draft = useChatStore((state) => state.draft);
  const setDraft = useChatStore((state) => state.setDraft);
  const endRef = useRef<HTMLDivElement>(null);
  const busy = status === "submitted" || status === "streaming";

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;

    setDraft("");
    void sendMessage({ text });
  }

  return (
    <main className="mx-auto flex h-[calc(100dvh-4rem)] max-w-4xl flex-col px-4 sm:px-8">
      <div className="flex items-center justify-between gap-4 border-b border-border py-5">
        <h1 className="text-lg font-semibold">Agent 对话</h1>
        <Button
          variant="outline"
          disabled={busy || !messages.length}
          onClick={() => {
            setMessages([]);
            clearError();
            setDraft("");
          }}
        >
          <Plus aria-hidden="true" /> 新对话
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-6">
        {messages.length === 0 && (
          <div className="grid h-full min-h-44 place-content-center justify-items-center gap-4 text-center">
            <Bot aria-hidden="true" className="size-12 rounded-2xl bg-accent p-2.5 text-primary" />
            <h2 className="text-xl font-semibold">开始一段对话</h2>
            <Button variant="outline" onClick={() => setDraft(examplePrompt)}>
              <Clock3 aria-hidden="true" /> 查询上海时间
            </Button>
          </div>
        )}
        <div className="space-y-5" role="log" aria-label="对话消息" aria-live="off">
          {messages.map((message) => (
            <article
              key={message.id}
              aria-label={message.role === "user" ? "你" : "Agent"}
              className={cn(
                "w-fit max-w-[90%] space-y-2 rounded-2xl px-4 py-3 text-sm leading-7",
                message.role === "user" ? "ml-auto bg-secondary" : "border border-border bg-card",
              )}
            >
              {message.parts.map((part, index) => {
                if (part.type === "text") {
                  return <p key={index} className="whitespace-pre-wrap wrap-break-word">{part.text}</p>;
                }
                if (part.type === "tool-getCurrentTime") {
                  return (
                    <p key={index} className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Clock3 aria-hidden="true" className="size-3.5" />
                      {part.state === "output-error"
                        ? "时间查询失败"
                        : part.state === "output-available"
                          ? "已调用时间查询工具"
                          : "正在查询时间…"}
                    </p>
                  );
                }
                return null;
              })}
            </article>
          ))}
          {status === "submitted" && <p role="status" className="text-sm text-muted-foreground">正在等待 Agent 响应…</p>}
          <div ref={endRef} />
        </div>
      </div>
      <div className="space-y-2 border-t border-border py-4">
        {error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}
        <form onSubmit={submit} className="flex items-center gap-2">
          <Input
            aria-label="消息"
            placeholder="输入消息…"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={8000}
            className="h-12"
          />
          {busy ? (
            <Button type="button" variant="outline" size="icon" aria-label="停止生成" onClick={() => void stop()}>
              <Square aria-hidden="true" />
            </Button>
          ) : (
            <Button type="submit" size="icon" aria-label="发送消息" disabled={!draft.trim()}>
              <ArrowUp aria-hidden="true" />
            </Button>
          )}
        </form>
      </div>
    </main>
  );
}

export function AgentWorkspace() {
  const { data: session, isPending, error: sessionError, refetch } = authClient.useSession();
  const setDraft = useChatStore((state) => state.setDraft);
  const [signOutError, setSignOutError] = useState(false);

  async function signOut() {
    setSignOutError(false);
    try {
      const { error } = await authClient.signOut();
      if (error) {
        setSignOutError(true);
        return;
      }
      setDraft("");
    } catch {
      setSignOutError(true);
    }
  }

  return (
    <>
      <header className="flex h-16 items-center justify-between gap-4 border-b border-border bg-card px-4 sm:px-8">
        <div className="flex items-center gap-2.5 font-semibold">
          <Bot aria-hidden="true" className="size-8 rounded-lg bg-primary p-1.5 text-primary-foreground" />
          Agent Practice
        </div>
        {session && (
          <div className="flex min-w-0 items-center gap-3">
            {signOutError && <p role="alert" className="text-sm text-destructive">退出失败。</p>}
            <span className="hidden truncate text-sm text-muted-foreground sm:block">{session.user.email}</span>
            <Button variant="ghost" onClick={() => void signOut()}>
              <LogOut aria-hidden="true" /> 退出
            </Button>
          </div>
        )}
      </header>
      {isPending ? (
        <main className="p-8 text-center text-sm text-muted-foreground" role="status">正在检查登录状态…</main>
      ) : sessionError ? (
        <main className="space-y-4 p-8 text-center">
          <p role="alert" className="text-sm text-destructive">无法连接登录服务。</p>
          <Button variant="outline" onClick={() => void refetch()}>重试</Button>
        </main>
      ) : session ? (
        <Chat key={session.user.id} />
      ) : (
        <AuthForm />
      )}
    </>
  );
}
