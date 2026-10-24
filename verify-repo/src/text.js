// Text helpers. This file is CORRECT: Shoal should leave it alone.

// "Hello World!" -> "hello-world"
export function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// "aggie" -> "Aggie"
export function capitalize(word) {
  return word ? word[0].toUpperCase() + word.slice(1) : "";
}
