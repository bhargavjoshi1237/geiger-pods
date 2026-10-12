// Halcyon Studio: the one fictional company every Geiger playground tells a
// story about, so the suite reads as connected — the same people, clients and
// places appear in Notes, Events, Forms, Assets and the rest.
//
// Plain data, no imports: seeds in every app build on it. Keep this file
// identical across repos (canonical copy:
// C:\Pro\docs\superpowers\playground-kit\lib\playground\cast.js).

export const STUDIO = {
  name: "Halcyon Studio",
  shortName: "Halcyon",
  domain: "halcyon.studio",
  tagline: "Brand, campaign and event work for companies people love.",
  brandColor: "#E8613C",
  accentColor: "#2F6F73",
  founded: 2016,
  headcount: 40,
  cities: ["Lisbon", "Brooklyn"],
};

// Stable person ids shared by every app's seed, so "Maya Chen" is the same
// user everywhere: personId(2) -> "ca570000-0000-4000-8000-000000000002".
export function personId(n) {
  return `ca570000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

// role: workspace role key most apps understand (owner/admin/manager/member/viewer).
export const PEOPLE = [
  { n: 1, name: "Alex Rivera", first: "Alex", last: "Rivera", role: "owner", title: "Founder & Creative Director", city: "Lisbon", color: "#E8613C" },
  { n: 2, name: "Maya Chen", first: "Maya", last: "Chen", role: "admin", title: "Head of Operations", city: "Brooklyn", color: "#2F6F73" },
  { n: 3, name: "Jonas Weber", first: "Jonas", last: "Weber", role: "manager", title: "Design Director", city: "Lisbon", color: "#6C5CE7" },
  { n: 4, name: "Sofia Rossi", first: "Sofia", last: "Rossi", role: "manager", title: "Head of Production", city: "Lisbon", color: "#D4A017" },
  { n: 5, name: "Ravi Patel", first: "Ravi", last: "Patel", role: "member", title: "Senior Designer", city: "Brooklyn", color: "#0984E3" },
  { n: 6, name: "Ava Johnson", first: "Ava", last: "Johnson", role: "member", title: "Producer", city: "Brooklyn", color: "#E84393" },
  { n: 7, name: "Kenji Watanabe", first: "Kenji", last: "Watanabe", role: "member", title: "Motion Designer", city: "Lisbon", color: "#00B894" },
  { n: 8, name: "Noor Haddad", first: "Noor", last: "Haddad", role: "member", title: "Strategist", city: "Brooklyn", color: "#A0522D" },
  { n: 9, name: "Lucas Moreau", first: "Lucas", last: "Moreau", role: "member", title: "Developer", city: "Lisbon", color: "#636E72" },
  { n: 10, name: "Priya Nair", first: "Priya", last: "Nair", role: "member", title: "Marketing Lead", city: "Brooklyn", color: "#FD7E14" },
  { n: 11, name: "Tomás Silva", first: "Tomás", last: "Silva", role: "member", title: "Events Coordinator", city: "Lisbon", color: "#20C997" },
  { n: 12, name: "Hana Kim", first: "Hana", last: "Kim", role: "viewer", title: "Finance Manager", city: "Brooklyn", color: "#845EF7" },
].map((p) => ({
  ...p,
  id: personId(p.n),
  email: `${p.first.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")}@halcyon.studio`,
  initials: `${p.first[0]}${p.last[0]}`,
  avatar_url: "",
}));

// The signed-in visitor in every playground.
export const PLAYGROUND_PERSON = PEOPLE[0];

export function person(n) {
  return PEOPLE.find((p) => p.n === n) ?? PEOPLE[0];
}

export const CLIENTS = [
  { key: "northwind", name: "Northwind Outdoor", industry: "Outdoor apparel", city: "Portland", contact: "Erin Walsh", email: "erin@northwind-outdoor.example" },
  { key: "atlas", name: "Atlas Coffee Roasters", industry: "Food & beverage", city: "Lisbon", contact: "Diogo Matos", email: "diogo@atlascoffee.example" },
  { key: "lumen", name: "Lumen Health", industry: "Healthcare", city: "Boston", contact: "Grace Okafor", email: "grace@lumenhealth.example" },
  { key: "kestrel", name: "Kestrel Bikes", industry: "Mobility", city: "Amsterdam", contact: "Pieter de Vries", email: "pieter@kestrelbikes.example" },
  { key: "solace", name: "Solace Hotels", industry: "Hospitality", city: "Barcelona", contact: "Lucía Ferrer", email: "lucia@solacehotels.example" },
  { key: "orbit", name: "Orbit Audio", industry: "Consumer electronics", city: "Berlin", contact: "Felix Brandt", email: "felix@orbitaudio.example" },
  { key: "fernway", name: "Fernway Foods", industry: "Grocery", city: "London", contact: "Amara Osei", email: "amara@fernway.example" },
  { key: "meridian", name: "Meridian Bank", industry: "Financial services", city: "New York", contact: "Daniel Price", email: "daniel@meridianbank.example" },
];

export function client(key) {
  return CLIENTS.find((c) => c.key === key) ?? CLIENTS[0];
}

export const LOCATIONS = [
  { key: "lisbon-hq", name: "Halcyon Lisbon", address: "Rua da Boavista 42", city: "Lisbon", country: "Portugal" },
  { key: "brooklyn", name: "Halcyon Brooklyn", address: "55 Water St", city: "Brooklyn", country: "USA" },
  { key: "lx-factory", name: "LX Factory", address: "Rua Rodrigues de Faria 103", city: "Lisbon", country: "Portugal" },
  { key: "pier-17", name: "Pier 17", address: "89 South St", city: "New York", country: "USA" },
];

// The running storylines apps can reference so the suite cross-links: the same
// launch shows up as a board in Notes, a campaign in Campaign, an event in
// Events and a form in Forms.
export const STORYLINES = [
  { key: "kestrel-launch", name: "Kestrel Aero launch", client: "kestrel", summary: "Brand film, launch event and pre-order campaign for Kestrel's new e-bike." },
  { key: "atlas-rebrand", name: "Atlas Coffee rebrand", client: "atlas", summary: "Identity refresh, packaging system and café rollout." },
  { key: "solace-summer", name: "Solace Summer '26", client: "solace", summary: "Seasonal campaign across 12 hotels." },
  { key: "halcyon-summit", name: "Halcyon Creative Summit", client: null, summary: "The studio's own annual two-day conference in Lisbon." },
];
