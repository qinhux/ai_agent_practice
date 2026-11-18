import { AuthForm } from "@/components/auth-form";

export default async function LoginPage({ searchParams }: {
  searchParams: Promise<{ verified?: string; error?: string }>;
}) {
  const query = await searchParams;
  return <AuthForm verified={query.verified === "1"} linkError={Boolean(query.error)} />;
}
