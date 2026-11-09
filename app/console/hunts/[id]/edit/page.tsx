import { prisma } from "@/lib/prisma";
import { requireConsoleTenant } from "@/lib/console-session";
import { NoOrganization } from "@/components/NoOrganization";
import { huntQueryIsValid, huntToFormValues } from "@/lib/hunt-form";
import { HuntForm } from "@/components/HuntForm";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function EditHuntPage({ params }: { params: { id: string } }) {
  const caller = await requireConsoleTenant();
  if ("noOrganization" in caller) return <NoOrganization />;
  const { tenantId } = caller;

  // Scoped to the session's tenant: another tenant's hunt is a 404, never its contents.
  const hunt = await prisma.hunt.findFirst({ where: { id: params.id, tenantId } });
  if (!hunt) notFound();

  return (
    <div>
      <a href={`/console/hunts/${hunt.id}`} className="text-sm text-indigo-700 hover:underline">
        ← {hunt.name}
      </a>
      <h2 className="mt-2 mb-6 text-2xl font-bold text-gray-900">Edit hunt</h2>
      <HuntForm huntId={hunt.id} initial={huntToFormValues(hunt)} queryInvalid={!huntQueryIsValid(hunt.query)} />
    </div>
  );
}
