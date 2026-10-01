import { createClient } from "@supabase/supabase-js";

let _c = null;
export function sb() {
  if (!_c) _c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  return _c;
}

export function normName(s) {
  return (s || "").toLowerCase().replace(/\s|\(주\)|㈜|주식회사|\(유\)|유한회사/g, "");
}
