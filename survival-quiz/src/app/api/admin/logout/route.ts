import { ADMIN_COOKIE } from "@/lib/server/admin-auth";
import { json } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export function POST() {
  const res = json({ ok: true });
  res.cookies.delete(ADMIN_COOKIE);
  return res;
}
