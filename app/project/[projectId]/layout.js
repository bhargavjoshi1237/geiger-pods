// Server entry for the project workspace, as in geiger-events. Holds nothing
// but the segment config: the page is a client component, and route segment
// config cannot be exported from one.
//
// force-static: nothing in this subtree reads the request, so Link prefetches
// the whole route and switching sidebar screens is a client-side transition —
// no server render and no route loader between screens. Screen data resolves
// client-side, inside each screen.

export const dynamic = "force-static";

export default function ProjectIdLayout({ children }) {
  return children;
}
