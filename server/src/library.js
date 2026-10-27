// Each GitHub account's library: marketplace listings (agents and models) it
// saved, and pods that group them, so a bounty's competitors can be
// picked from them in one go instead of from the whole marketplace.
//
// state.libraries: { [login]: { saved: [{ id, savedAt }], favorites: [id], pods: [{ id, name, description, listings: [id], createdAt, updatedAt }] } }
//
// Favorites are the saved listings the account starred, shown first.
// Favoriting also saves; unsaving also unfavorites.
// A pod holds at most as many listings as can compete on one bounty.
// Adding a listing to a pod also saves it. Listings removed from the
// marketplace stay in the library and are reported as missing, so nothing
// disappears silently; the platform hides them from pickers.
import { newId, state } from "./store.js";

const httpError = (status, message) => Object.assign(new Error(message), { status });
export const MAX_SAVED = 200;
export const MAX_PODS = 50;
export const MAX_PER_POD = 12;
const MAX_NAME = 60;
const MAX_DESCRIPTION = 280;

function signedIn(user) {
  if (!user?.login) throw httpError(401, "Sign in with GitHub to use your library");
  const lib = (state.libraries[user.login] ??= { saved: [], favorites: [], pods: [] });
  lib.favorites ??= [];
  return lib;
}

const cleanName = (name) => {
  const n = String(name ?? "").trim().replace(/\s+/g, " ");
  if (!n) throw httpError(400, "Give the pod a name");
  if (n.length > MAX_NAME) throw httpError(400, `Pod names are at most ${MAX_NAME} characters`);
  return n;
};

// Optional: what the pod is for, in the team's own words.
const cleanDescription = (text) => {
  const d = String(text ?? "").trim();
  if (d.length > MAX_DESCRIPTION) throw httpError(400, `Pod descriptions are at most ${MAX_DESCRIPTION} characters`);
  return d;
};

function cleanListings(ids, exists) {
  if (!Array.isArray(ids)) throw httpError(400, "listings must be a list of marketplace listing ids");
  const unique = [...new Set(ids.map(String))];
  const unknown = unique.find((id) => !exists(id));
  if (unknown) throw httpError(404, `No marketplace listing ${unknown}`);
  if (unique.length > MAX_PER_POD) throw httpError(400, `A pod holds at most ${MAX_PER_POD} agents, as many as can compete on one bounty`);
  return unique;
}

function save(lib, id) {
  if (lib.saved.some((x) => x.id === id)) return;
  if (lib.saved.length >= MAX_SAVED) throw httpError(400, `Your library holds at most ${MAX_SAVED} agents and models`);
  lib.saved.unshift({ id, savedAt: new Date().toISOString() });
}

const findPod = (lib, id) => {
  const p = lib.pods.find((x) => x.id === id);
  if (!p) throw httpError(404, `No pod ${id} in your library`);
  return p;
};

// What the platform shows. exists(id) says whether the listing is still in the marketplace.
export function libraryFor(user, exists) {
  if (!user?.login) return { signedIn: false, saved: [], favorites: [], pods: [], limits: limits() };
  const lib = state.libraries[user.login] ?? { saved: [], pods: [] };
  const favorites = lib.favorites ?? [];
  return {
    signedIn: true,
    saved: lib.saved.map((x) => ({ ...x, favorite: favorites.includes(x.id), missing: !exists(x.id) })),
    favorites,
    pods: lib.pods.map((p) => ({ ...p, description: p.description ?? "", missing: p.listings.filter((id) => !exists(id)) })),
    limits: limits(),
  };
}
const limits = () => ({ saved: MAX_SAVED, pods: MAX_PODS, perPod: MAX_PER_POD, name: MAX_NAME, description: MAX_DESCRIPTION });

export function saveListing(id, user, exists) {
  const lib = signedIn(user);
  if (!exists(String(id ?? ""))) throw httpError(404, `No marketplace listing ${id}`);
  save(lib, String(id));
  return libraryFor(user, exists);
}

// Unsaving also takes it out of favorites and every pod.
export function unsaveListing(id, user, exists) {
  const lib = signedIn(user);
  lib.saved = lib.saved.filter((x) => x.id !== id);
  lib.favorites = lib.favorites.filter((x) => x !== id);
  for (const p of lib.pods) if (p.listings.includes(id)) Object.assign(p, { listings: p.listings.filter((x) => x !== id), updatedAt: new Date().toISOString() });
  return libraryFor(user, exists);
}

// Star a listing (saving it too), or take the star off (it stays saved).
export function favoriteListing(id, on, user, exists) {
  const lib = signedIn(user);
  id = String(id ?? "");
  if (on) {
    if (!exists(id)) throw httpError(404, `No marketplace listing ${id}`);
    save(lib, id);
    if (!lib.favorites.includes(id)) lib.favorites.unshift(id);
  } else {
    lib.favorites = lib.favorites.filter((x) => x !== id);
  }
  return libraryFor(user, exists);
}

export function createPod({ name, description = "", listings = [] } = {}, user, exists) {
  const lib = signedIn(user);
  if (lib.pods.length >= MAX_PODS) throw httpError(400, `You can have at most ${MAX_PODS} pods`);
  const ids = cleanListings(listings, exists);
  const now = new Date().toISOString();
  const pod = { id: newId("pod"), name: cleanName(name), description: cleanDescription(description), listings: ids, createdAt: now, updatedAt: now };
  ids.forEach((id) => save(lib, id));
  lib.pods.push(pod);
  return { pod, library: libraryFor(user, exists) };
}

// Changes: { name?, description?, listings? } (listings replaces the whole list, in order).
export function updatePod(id, changes = {}, user, exists) {
  const lib = signedIn(user);
  const p = findPod(lib, id);
  const name = changes.name === undefined ? p.name : cleanName(changes.name);
  const description = changes.description === undefined ? p.description ?? "" : cleanDescription(changes.description);
  // Listings already in it that left the marketplace may stay; new ones must exist.
  const ids = changes.listings === undefined ? p.listings : cleanListings(changes.listings, (x) => p.listings.includes(x) || exists(x));
  ids.forEach((x) => save(lib, x));
  Object.assign(p, { name, description, listings: ids, updatedAt: new Date().toISOString() });
  return { pod: p, library: libraryFor(user, exists) };
}

export function deletePod(id, user, exists) {
  const lib = signedIn(user);
  findPod(lib, id);
  lib.pods = lib.pods.filter((x) => x.id !== id);
  return libraryFor(user, exists);
}

// Saved libraries from before pods had their name: they were "lineups",
// and before that "playlists".
export function loadLibraries(saved) {
  return Object.fromEntries(Object.entries(saved ?? {}).map(([login, { saved: s = [], pods, lineups, playlists, ...rest }]) => [login, { ...rest, saved: s, favorites: rest.favorites ?? [], pods: pods ?? lineups ?? playlists ?? [] }]));
}

// Deleting the account forgets its library too.
export function forgetLibrary(login) {
  delete state.libraries[login];
}
