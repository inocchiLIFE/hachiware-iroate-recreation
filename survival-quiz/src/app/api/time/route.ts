// 端末の時計とサーバー時刻のずれを補正するための時刻 API
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ now: Date.now() }, { headers: { "Cache-Control": "no-store" } });
}
