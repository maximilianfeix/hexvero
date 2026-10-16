// Names of the people who contributed to a repository, for the release's credits line.

const CODE_API = "https://code.tidemark.example/api/v1/";

export async function loadContributors(repo) {
  const url = new URL(`repos/${repo}/contributors`, CODE_API);
  url.searchParams.set("limit", "50");
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`contributors: HTTP ${res.status}`);
  const people = await res.json();
  return people.map((person) => person.name || person.login);
}
