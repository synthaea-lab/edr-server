import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { damageManifestOf } from "@/lib/damage-manifest";
import { requireTenantMember } from "@/lib/admin-auth";
import { NotFound, route } from "@/lib/http/handler";
import { loadCaseDetail } from "@/lib/case-detail";

/**
 * GET /api/cases/[id]
 *
 * Response: { case, detections, narrative: (CaseNarrative & { stale }) | null,
 *             prevalence: { [detectionId]: { lines, omitted } },
 *             damageManifest: { files, truncated } }
 *
 * `damageManifest` is the files the case's ransomware detections (T1486) say their process
 * renamed or deleted, for a restoration scope (issue #82); empty for any other case.
 *
 * `prevalence` is the fleet triage fact for what each detection's event touched
 * (issue #76): "seen on N hosts, first <date>", rarest first.
 *
 * `stale` is derived, not stored: true when a detection was attached to the
 * case after the latest narrative was generated.
 */
export const GET = route(
  "GET /api/cases/[id]",
  async (req: NextRequest, { params }: { params: { id: string } }) => {
    const authed = requireTenantMember(req);
    if ("response" in authed) return authed.response;
    const { tenantId } = authed;
    const detail = await loadCaseDetail(prisma, tenantId, params.id);
    if (!detail) throw new NotFound("Case not found");

    return NextResponse.json({ ...detail, damageManifest: damageManifestOf(detail.detections) });
  }
);
