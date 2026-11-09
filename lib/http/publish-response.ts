import { NextResponse } from "next/server";
import type { PublishOutcome } from "@/lib/release-publish";

/**
 * The HTTP answer to a release publish (`POST /api/release`, `POST /api/content/release`):
 * 200 with the new row, 409 when the number is taken or not above the ring's latest, 422 when
 * the manifest or an artifact would not install on an agent.
 */
export function publishResponse(result: PublishOutcome): NextResponse {
  switch (result.outcome) {
    case "created":
      return NextResponse.json({ status: "created", release: result.release });
    case "conflict":
      return NextResponse.json(
        result.latest === undefined
          ? { error: result.error }
          : { error: result.error, latest: result.latest },
        { status: 409 }
      );
    case "unpublishable":
      return NextResponse.json({ error: result.error }, { status: 422 });
  }
}
