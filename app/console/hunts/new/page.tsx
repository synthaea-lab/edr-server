import { requireConsoleTenant } from "@/lib/console-session";
import { NoOrganization } from "@/components/NoOrganization";
import { HuntForm } from "@/components/HuntForm";

export const dynamic = "force-dynamic";

export default async function NewHuntPage() {
  const caller = await requireConsoleTenant();
  if ("noOrganization" in caller) return <NoOrganization />;

  return (
    <div>
      <a href="/console/hunts" className="text-sm text-indigo-700 hover:underline">
        ← Hunts
      </a>
      <h2 className="mt-2 mb-6 text-2xl font-bold text-gray-900">New hunt</h2>
      <HuntForm />
    </div>
  );
}
