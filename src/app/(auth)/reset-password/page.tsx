import { AuthForm } from "@/components/auth-form";

export default async function ResetPasswordPage({ searchParams }: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const query = await searchParams;
  return <AuthForm mode="reset" token={query.token} linkError={Boolean(query.error)} />;
}
