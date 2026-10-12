// Everything the playground swaps into the data layer while it is mounted (see
// ./mode.js and ./use_playground_mode.js). Pods screens talk to the v1
// management API with fetch(), so most of the work is ./api_routes.js; the
// Supabase client stand-in covers anything that still builds a browser client.

import { createMemoryClient } from "./memory_client.js";
import { getPlaygroundDb, PLAYGROUND_USER } from "./db.js";
import { API_ROUTES } from "./api_routes.js";

// One client for the whole session, so every createClient() call shares state.
let client = null;

function createPlaygroundClient() {
  client ??= createMemoryClient({
    getDb: getPlaygroundDb,
    user: PLAYGROUND_USER,
  });
  return client;
}

export const playgroundHandlers = {
  createClient: createPlaygroundClient,
};

// Routes for interceptFetch (see ./intercept_fetch.js).
export const playgroundRoutes = API_ROUTES;
