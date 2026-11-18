import { AuthForm } from "@/components/auth-form";

export default async function VerifyEmailPage({ searchParams }: {
  searchParams: Promise<{ email?: string }>;
}) {
  const query = await searchParams;
  return <AuthForm mode="verify" initialEmail={typeof query.email === "string" ? query.email : ""} />;
}
