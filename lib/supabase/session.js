// Browser identity comes from the parent's cookie-backed session, as in Events.
// Project access is still enforced by Supabase RLS and organization membership.
export function subscribeToSession(client, onChange) {
  let alive = true;
  let revision = 0;
  const update = (session) => {
    onChange({ status: session?.user ? "authenticated" : "signed-out", user: session?.user ?? null, error: null });
  };
  const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
    if (!alive) return;
    revision++;
    update(session);
  });

  return {
    async refresh() {
      const current = ++revision;
      try {
        const { data: { session }, error } = await client.auth.getSession();
        if (!alive || current !== revision) return;
        if (error) throw error;
        update(session);
      } catch (error) {
        if (alive && current === revision) onChange({ status: "error", user: null, error: error.message });
      }
    },
    unsubscribe() {
      alive = false;
      revision++;
      subscription.unsubscribe();
    },
  };
}
