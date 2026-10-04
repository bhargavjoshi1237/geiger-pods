// Fixtures for the landing-page playground: a signed-in demo reader on one demonstrator project.
export const PLAYGROUND_USER = { id: "playground-user", email: "you@yourteam.dev" };

export const PLAYGROUND_PROJECT = {
  id: "playground", name: "Acme Storefront", slug: "acme-storefront",
  organizationId: null, createdBy: PLAYGROUND_USER.id, status: "active",
  createdAt: "2026-10-01T00:00:00.000Z", inheritedRole: "owner",
};

// Suite-shared showcase backgrounds (same set as geiger-flow / geiger-content).
export const SHOWCASE_BACKGROUNDS = [
  "https://200rfrtp5x71tlmk.public.blob.vercel-storage.com/geiger-dash/cursor-assets/asset-00a586c62c8782e65c0a.jpg",
  "https://200rfrtp5x71tlmk.public.blob.vercel-storage.com/geiger-dash/cursor-assets/internal-brand-023-3291bb4c.jpg",
  "https://200rfrtp5x71tlmk.public.blob.vercel-storage.com/geiger-dash/cursor-assets/asset-0ec1f3ba625f482c9dc3.jpg",
  "https://200rfrtp5x71tlmk.public.blob.vercel-storage.com/geiger-dash/cursor-assets/asset-85923e7fafe00c9c0d1f.jpg",
  "https://200rfrtp5x71tlmk.public.blob.vercel-storage.com/geiger-dash/cursor-assets/asset-8e2e88cff7f33224ddd7.jpg",
  "https://200rfrtp5x71tlmk.public.blob.vercel-storage.com/geiger-dash/cursor-assets/asset-0a66efa21dd4b7e6c526.jpg",
  "https://200rfrtp5x71tlmk.public.blob.vercel-storage.com/geiger-dash/cursor-assets/asset-cc24ca462279ca23250c.jpg",
];

export function pickShowcaseBackground(random = Math.random) {
  return SHOWCASE_BACKGROUNDS[Math.floor(random() * SHOWCASE_BACKGROUNDS.length)];
}
