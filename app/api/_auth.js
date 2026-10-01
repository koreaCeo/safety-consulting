export async function requireUser(req) {
  const h = req.headers.get("authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return null;
  const r = await fetch(process.env.NEXT_PUBLIC_SUPABASE_URL + "/auth/v1/user", {
    headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, authorization: "Bearer " + token },
  });
  if (!r.ok) return null;
  return await r.json();
}
