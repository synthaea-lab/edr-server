/** What a console page shows a signed-in user whose session has no active organization. */
export function NoOrganization() {
  return (
    <div className="rounded-lg bg-yellow-50 p-4">
      <p className="text-sm text-yellow-800">
        No organization selected. Please contact your administrator.
      </p>
    </div>
  );
}
