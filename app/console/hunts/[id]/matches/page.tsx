import { prisma } from "@/lib/prisma";
import { requireConsoleTenant } from "@/lib/console-session";
import { NoOrganization } from "@/components/NoOrganization";
import { HuntValidationError, parseHuntQuery } from "@/lib/hunt";
import { MAX_CONCURRENT_SEARCHES_PER_TENANT, searchFailure, searchWithinLimit, type SearchPage } from "@/lib/hunt-search";
import { describeQuery } from "@/lib/hunt-view";
import { searchHref, type SearchParams } from "@/lib/hunt-search-form";
import { SearchResults } from "@/components/SearchResults";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

/** What a saved hunt's query matches now, newest first. A saved hunt's runs keep counts and ids; this lists the detections. */
export default async function HuntMatchesPage({ params, searchParams }: { params: { id: string }; searchParams: SearchParams }) {
  const caller = await requireConsoleTenant();
  if ("noOrganization" in caller) return <NoOrganization />;
  const { tenantId } = caller;

  // Scoped to the session's tenant: another tenant's hunt is a 404, never its contents.
  const hunt = await prisma.hunt.findFirst({ where: { id: params.id, tenantId } });
  if (!hunt) notFound();

  let page: SearchPage | null = null;
  let problem: string | null = null;
  try {
    const query = parseHuntQuery(hunt.query);
    const cursor = typeof searchParams.cursor === "string" && searchParams.cursor ? searchParams.cursor : undefined;
    const outcome = await searchWithinLimit(prisma, tenantId, { source: "detections", query, cursor });
    if (outcome.status === "busy") {
      problem = `At most ${MAX_CONCURRENT_SEARCHES_PER_TENANT} searches at a time per tenant; try again shortly.`;
    } else {
      page = outcome.page;
    }
  } catch (error) {
    if (error instanceof HuntValidationError) {
      problem = `This hunt's stored query no longer parses (${error.message}). Edit the hunt to repair it.`;
    } else {
      const failure = searchFailure(error);
      if (failure.status === 500) console.error("Hunt matches page error:", error);
      problem = failure.status === 500 ? "The search failed (see the server log)." : failure.message;
    }
  }

  return (
    <div>
      <a href={`/console/hunts/${hunt.id}`} className="text-sm text-indigo-700 hover:underline">← {hunt.name}</a>
      <h2 className="mt-2 text-2xl font-bold text-gray-900">Matches now</h2>
      <p className="mt-1 mb-4 text-sm text-gray-600">{describeQuery(hunt.query)}</p>
      {problem && (
        <p className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">{problem}</p>
      )}
      {page && <SearchResults page={page} olderHref={page.nextCursor ? searchHref(searchParams, page.nextCursor) : null} />}
    </div>
  );
}
