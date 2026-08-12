// Generates assets/stats-card.svg and assets/langs-card.svg from real GitHub
// data via the GraphQL API, styled to match the README's terminal theme.
// Runs in CI (.github/workflows/stats.yml) using the default GITHUB_TOKEN,
// which is enough because everything queried here is public profile data.

const USERNAME = process.env.USERNAME;
const TOKEN = process.env.GH_TOKEN;

if (!USERNAME || !TOKEN) {
  console.error("Missing USERNAME or GH_TOKEN env vars");
  process.exit(1);
}

async function gql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    throw new Error("GraphQL error: " + JSON.stringify(json.errors));
  }
  return json.data;
}

async function fetchRepoStats(login) {
  let cursor = null;
  let hasNext = true;
  let totalStars = 0;
  const langSizes = new Map(); // name -> { size, color }

  while (hasNext) {
    const data = await gql(
      `query($login: String!, $cursor: String) {
        user(login: $login) {
          repositories(first: 100, after: $cursor, ownerAffiliations: [OWNER], isFork: false, privacy: PUBLIC) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes {
              stargazerCount
              languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
                edges { size node { name color } }
              }
            }
          }
        }
      }`,
      { login, cursor }
    );
    const repos = data.user.repositories;
    for (const repo of repos.nodes) {
      totalStars += repo.stargazerCount;
      for (const edge of repo.languages.edges) {
        const key = edge.node.name;
        const prev = langSizes.get(key) || { size: 0, color: edge.node.color || "#8b949e" };
        prev.size += edge.size;
        langSizes.set(key, prev);
      }
    }
    hasNext = repos.pageInfo.hasNextPage;
    cursor = repos.pageInfo.endCursor;
  }

  return { totalStars, langSizes };
}

async function fetchProfileAggregates(login) {
  const data = await gql(
    `query($login: String!) {
      user(login: $login) {
        pullRequests(first: 1) { totalCount }
        issues(first: 1) { totalCount }
        repositoriesContributedTo(first: 1, contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, REPOSITORY]) { totalCount }
        contributionsCollection { contributionYears }
      }
    }`,
    { login }
  );
  return data.user;
}

async function fetchTotalCommits(login, years) {
  let total = 0;
  for (const year of years) {
    const from = `${year}-01-01T00:00:00Z`;
    const to = `${year}-12-31T23:59:59Z`;
    const data = await gql(
      `query($login: String!, $from: DateTime!, $to: DateTime!) {
        user(login: $login) {
          contributionsCollection(from: $from, to: $to) {
            totalCommitContributions
          }
        }
      }`,
      { login, from, to }
    );
    total += data.user.contributionsCollection.totalCommitContributions;
  }
  return total;
}

// Rough, transparent heuristic (not a copy of any third-party formula):
// diminishing-returns score per metric against a "typical active dev" reference,
// averaged into a 0-100 score and mapped to a letter grade.
function computeGrade({ commits, prs, issues, stars, contribs }) {
  const ref = { commits: 250, prs: 50, issues: 25, stars: 50, contribs: 6 };
  const norm = (v, m) => 1 - Math.exp(-v / m);
  const score =
    (norm(commits, ref.commits) +
      norm(prs, ref.prs) +
      norm(issues, ref.issues) +
      norm(stars, ref.stars) +
      norm(contribs, ref.contribs)) /
    5;
  const pct = Math.round(score * 100);
  let grade = "C";
  if (pct >= 90) grade = "S";
  else if (pct >= 80) grade = "A+";
  else if (pct >= 65) grade = "A";
  else if (pct >= 50) grade = "A-";
  else if (pct >= 38) grade = "B+";
  else if (pct >= 26) grade = "B";
  else if (pct >= 15) grade = "B-";
  else if (pct >= 8) grade = "C+";
  return { pct, grade };
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmt(n) {
  return n.toLocaleString("en-US");
}

function renderStatsCard(login, stats) {
  const { pct, grade } = computeGrade(stats);
  const r = 46;
  const circumference = 2 * Math.PI * r;
  const dash = (pct / 100) * circumference;

  const rows = [
    ["Total Stars", stats.stars],
    ["Total Commits", stats.commits],
    ["Total PRs", stats.prs],
    ["Total Issues", stats.issues],
    ["Contributed To", stats.contribs],
  ];

  const rowsSvg = rows
    .map(
      ([label, value], i) => `
    <text x="24" y="${76 + i * 25}" font-size="13" fill="#9fe8bd">${esc(label)}</text>
    <text x="300" y="${76 + i * 25}" font-size="13" font-weight="700" fill="#baffdd" text-anchor="end" font-variant-numeric="tabular-nums">${fmt(value)}</text>`
    )
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 195" width="480" height="195" font-family="Consolas, Menlo, Monaco, monospace" role="img" aria-label="${esc(login)}'s GitHub stats">
  <defs>
    <filter id="g" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="2.2" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect x="0.5" y="0.5" width="479" height="194" rx="10" fill="#000000" fill-opacity="0.001" stroke="rgba(57,255,136,0.25)"/>
  <text x="24" y="32" font-size="15" font-weight="700" letter-spacing="0.5" fill="#39ff88" filter="url(#g)">${esc(login).toUpperCase()}'S GITHUB STATS</text>
  <line x1="24" y1="42" x2="456" y2="42" stroke="rgba(57,255,136,0.2)"/>
  ${rowsSvg}
  <g transform="translate(410,100)" filter="url(#g)">
    <circle r="${r}" fill="none" stroke="#123324" stroke-width="9"/>
    <circle r="${r}" fill="none" stroke="#39ff88" stroke-width="9" stroke-linecap="round"
      stroke-dasharray="${dash.toFixed(1)} ${circumference.toFixed(1)}"
      transform="rotate(-90)"/>
    <text x="0" y="7" font-size="22" font-weight="800" fill="#baffdd" text-anchor="middle">${grade}</text>
  </g>
</svg>`;
}

function renderLangsCard(login, langSizes) {
  const total = Array.from(langSizes.values()).reduce((a, b) => a + b.size, 0);
  const sorted = Array.from(langSizes.entries())
    .map(([name, v]) => ({ name, ...v, pct: total ? (v.size / total) * 100 : 0 }))
    .sort((a, b) => b.size - a.size);

  const top = sorted.slice(0, 5);
  const restPct = Math.max(0, 100 - top.reduce((a, b) => a + b.pct, 0));
  if (restPct > 0.5 && sorted.length > 5) {
    top.push({ name: "Other", color: "#6e7681", pct: restPct });
  }

  let x = 20;
  const barW = 440;
  const barSvg = top
    .map((l) => {
      const w = (l.pct / 100) * barW;
      const seg = `<rect x="${x.toFixed(1)}" y="50" width="${w.toFixed(1)}" height="10" fill="${l.color}"/>`;
      x += w;
      return seg;
    })
    .join("");

  const listSvg = top
    .map(
      (l, i) => `
    <circle cx="28" cy="${84 + i * 22 - 4}" r="4" fill="${l.color}"/>
    <text x="40" y="${84 + i * 22}" font-size="13" fill="#c9d1d9">${esc(l.name)}</text>
    <text x="456" y="${84 + i * 22}" font-size="13" fill="#8fe6b3" text-anchor="end" font-variant-numeric="tabular-nums">${l.pct.toFixed(1)}%</text>`
    )
    .join("");

  const height = 80 + top.length * 22 + 12;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 ${height}" width="480" height="${height}" font-family="Consolas, Menlo, Monaco, monospace" role="img" aria-label="${esc(login)}'s most used languages">
  <defs>
    <filter id="g2" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="2.2" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect x="0.5" y="0.5" width="479" height="${height - 1}" rx="10" fill="#000000" fill-opacity="0.001" stroke="rgba(57,255,136,0.25)"/>
  <text x="24" y="32" font-size="15" font-weight="700" letter-spacing="0.5" fill="#39ff88" filter="url(#g2)">MOST USED LANGUAGES</text>
  <line x1="24" y1="42" x2="456" y2="42" stroke="rgba(57,255,136,0.2)"/>
  <rect x="20" y="50" width="440" height="10" rx="5" fill="#123324"/>
  ${barSvg}
  ${listSvg}
</svg>`;
}

async function main() {
  const [{ totalStars, langSizes }, aggregates] = await Promise.all([
    fetchRepoStats(USERNAME),
    fetchProfileAggregates(USERNAME),
  ]);

  const commits = await fetchTotalCommits(USERNAME, aggregates.contributionsCollection.contributionYears);

  const stats = {
    stars: totalStars,
    commits,
    prs: aggregates.pullRequests.totalCount,
    issues: aggregates.issues.totalCount,
    contribs: aggregates.repositoriesContributedTo.totalCount,
  };

  const fs = await import("node:fs/promises");
  await fs.mkdir("assets", { recursive: true });
  await fs.writeFile("assets/stats-card.svg", renderStatsCard(USERNAME, stats));
  await fs.writeFile("assets/langs-card.svg", renderLangsCard(USERNAME, langSizes));

  console.log("Stats:", stats);
  console.log("Wrote assets/stats-card.svg and assets/langs-card.svg");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
