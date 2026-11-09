import { prisma } from "@/lib/prisma";
import { requireConsoleTenant } from "@/lib/console-session";
import { NoOrganization } from "@/components/NoOrganization";
import { CaseList } from "@/components/CaseList";

// Read per request: the session needs a database, which does not exist at build time.
export const dynamic = "force-dynamic";

export default async function CasesPage() {
  const caller = await requireConsoleTenant();
  if ("noOrganization" in caller) return <NoOrganization />;
  const { tenantId } = caller;

  const cases = await prisma.case.findMany({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Cases</h2>
        <p className="mt-1 text-sm text-gray-600">
          Security incidents requiring investigation
        </p>
      </div>

      {cases.length === 0 ? (
        <div className="rounded-lg bg-gray-50 p-8 text-center">
          <p className="text-gray-600">No cases yet</p>
          <p className="mt-1 text-sm text-gray-500">
            Cases will appear here when detections are triggered
          </p>
        </div>
      ) : (
        <CaseList cases={cases} />
      )}
    </div>
  );
}
