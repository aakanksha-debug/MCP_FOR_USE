import { publishChanges, rejectChanges, undoBatch } from "@/approvals/publish";
import { PlatformError } from "@/platforms/types";
import { isSameOrigin, sameHostUrl } from "@/web/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function back(request: Request, token: string, notice: string): Response {
  const url = sameHostUrl(request, `/approve/${token}`);
  url.searchParams.set("notice", notice);
  return Response.redirect(url, 303);
}

/** Owner actions from the approval page: publish selected changes, reject, or undo. */
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!isSameOrigin(request)) return new Response("Forbidden", { status: 403 });
  const form = await request.formData();
  const action = String(form.get("action") ?? "");

  try {
    if (action === "publish") {
      const ids = form.getAll("change").map(String);
      if (!ids.length) return back(request, token, "Nothing was selected, so nothing was published.");
      const { published, failed } = await publishChanges(token, ids);
      return back(
        request,
        token,
        failed
          ? `Published ${published} change${published === 1 ? "" : "s"}; ${failed} could not be published (see below).`
          : `Published ${published} change${published === 1 ? "" : "s"}.`,
      );
    }
    if (action === "reject") {
      const skipped = await rejectChanges(token);
      return back(request, token, `Rejected ${skipped} change${skipped === 1 ? "" : "s"}. Nothing was published.`);
    }
    if (action === "undo") {
      await undoBatch(token, String(form.get("batch") ?? ""));
      return back(request, token, "Undo finished. Check the results below.");
    }
    return back(request, token, "Unknown action.");
  } catch (error) {
    if (!(error instanceof PlatformError)) console.error("[approvals] action failed", error);
    return back(request, token, error instanceof PlatformError ? error.message : "Something went wrong. Please try again.");
  }
}
