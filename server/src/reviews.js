// Reviews: what teams think of an agent or model, next to the numbers Shoal
// measured. Only verified buyers can review: the team whose bounty that
// listing won, once per bounty, after the survival window has ended (settled
// or clawed back), so every review is about a real, finished job.
// A review has 1-5 stars, text and optional aspect ratings. The listing's
// builder can post one public reply. Other people can mark it helpful.
// Stars never change the default "best" order; they're their own sort.
import { state, newId } from "./store.js";

export const ASPECTS = ["codeQuality", "prClarity", "speed"];
const REVIEWABLE = ["settled", "clawed_back"];
const MAX_TEXT = 4000;

const stars = (v, what) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw httpError(400, `${what} must be a whole number from 1 to 5`);
  return n;
};

// user: { login } of whoever is signed in. listingExists: (id) => boolean.
export function createReview({ listingId, bountyId, stars: rating, body, aspects = {} }, user, listingExists) {
  if (!user) throw httpError(401, "Sign in with GitHub to review");
  if (!listingExists(listingId)) throw httpError(404, `No marketplace listing ${listingId}`);
  const bounty = state.bounties.find((b) => b.id === bountyId);
  if (!bounty) throw httpError(404, `Unknown bounty ${bountyId}`);
  if (bounty.winner !== listingId) throw httpError(403, "You can only review the agent or model that won your bounty");
  if (bounty.postedBy && bounty.postedBy !== user.login) throw httpError(403, "Only the team that posted this bounty can review it");
  if (!REVIEWABLE.includes(bounty.status)) throw httpError(409, "Reviews open once the fix's survival window has ended");
  if (state.reviews.some((r) => r.bountyId === bountyId)) throw httpError(409, "This bounty has already been reviewed");
  const unknown = Object.keys(aspects ?? {}).filter((k) => !ASPECTS.includes(k));
  if (unknown.length) throw httpError(400, `Aspects can be ${ASPECTS.join(", ")}, not ${unknown.join(", ")}`);
  const review = {
    id: newId("review"),
    listingId,
    bountyId,
    reviewer: user.login,
    stars: stars(rating, "stars"),
    body: String(body ?? "").trim().slice(0, MAX_TEXT),
    aspects: Object.fromEntries(Object.entries(aspects ?? {}).filter(([, v]) => v != null).map(([k, v]) => [k, stars(v, k)])),
    // What happened to the fix, so readers can weigh the review.
    outcome: bounty.status,
    testFile: bounty.testFile,
    createdAt: new Date().toISOString(),
    reply: null,
  };
  state.reviews.unshift(review);
  return withVotes(review);
}

export function deleteReview(id, user) {
  const review = find(id);
  if (review.reviewer !== user?.login) throw httpError(403, "Only the reviewer can delete a review");
  state.reviews = state.reviews.filter((r) => r.id !== id);
  state.reviewVotes = state.reviewVotes.filter((v) => v.reviewId !== id);
}

// One public reply per review, from the listing's builder (the GitHub
// account that published it).
export function replyToReview(id, body, user, ownerOf) {
  const review = find(id);
  if (!user) throw httpError(401, "Sign in with GitHub to reply");
  if (ownerOf(review.listingId) !== user.login) throw httpError(403, "Only the builder of this agent can reply");
  if (review.reply) throw httpError(409, "This review already has a reply");
  const text = String(body ?? "").trim();
  if (!text) throw httpError(400, "The reply is empty");
  review.reply = { by: user.login, body: text.slice(0, MAX_TEXT), createdAt: new Date().toISOString() };
  return withVotes(review);
}

export function voteHelpful(id, user, helpful = true) {
  const review = find(id);
  if (!user) throw httpError(401, "Sign in with GitHub to vote");
  if (review.reviewer === user.login) throw httpError(400, "You can't vote on your own review");
  const has = state.reviewVotes.some((v) => v.reviewId === id && v.voter === user.login);
  if (helpful && !has) state.reviewVotes.push({ reviewId: id, voter: user.login, at: new Date().toISOString() });
  if (!helpful) state.reviewVotes = state.reviewVotes.filter((v) => !(v.reviewId === id && v.voter === user.login));
  return withVotes(review);
}

const REVIEW_SORTS = {
  helpful: (a, b) => b.helpful - a.helpful || b.createdAt.localeCompare(a.createdAt),
  newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
  highest: (a, b) => b.stars - a.stars || b.createdAt.localeCompare(a.createdAt),
  lowest: (a, b) => a.stars - b.stars || b.createdAt.localeCompare(a.createdAt),
};

export function reviewsFor(listingId, sort = "helpful") {
  if (!REVIEW_SORTS[sort]) throw httpError(400, `Review sort must be one of ${Object.keys(REVIEW_SORTS).join(", ")}`);
  return state.reviews.filter((r) => r.listingId === listingId).map(withVotes).sort(REVIEW_SORTS[sort]);
}

// Star summary for a listing: average, count, 1-5 distribution, aspects.
export function ratingFor(listingId) {
  const mine = state.reviews.filter((r) => r.listingId === listingId);
  const avg = (list) => (list.length ? Math.round((list.reduce((s, n) => s + n, 0) / list.length) * 10) / 10 : null);
  return {
    average: avg(mine.map((r) => r.stars)),
    count: mine.length,
    distribution: Object.fromEntries([5, 4, 3, 2, 1].map((n) => [n, mine.filter((r) => r.stars === n).length])),
    aspects: Object.fromEntries(ASPECTS.map((a) => [a, avg(mine.map((r) => r.aspects[a]).filter((v) => v != null))])),
  };
}

const withVotes = (r) => ({ ...r, helpful: state.reviewVotes.filter((v) => v.reviewId === r.id).length });

function find(id) {
  const review = state.reviews.find((r) => r.id === id);
  if (!review) throw httpError(404, `No review ${id}`);
  return review;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
