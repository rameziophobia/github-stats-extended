import {
  calculateRank,
  renderStatsCard,
} from "@stats-organization/github-readme-stats-core";

const GITHUB_API = "https://api.github.com/graphql";
const USERNAME = "rameziophobia";

// There are intentionally no repository names, contents, commit messages, PR
// titles, or email addresses in either query. read:user has no repository access
// and no write scope; private contribution totals come from the owner's profile.
const PROFILE_QUERY = `query {
  viewer {
    login name
    followers { totalCount }
    contributionsCollection { contributionYears }
    repositories(first: 100, privacy: PUBLIC, ownerAffiliations: OWNER) {
      nodes { stargazerCount }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

/**
 * Read the authenticated owner's aggregate contribution counters from GitHub.
 * @returns {Promise<object>} Aggregate numeric profile counters.
 */
export async function fetchProfileStats(token, request = fetch) {
  if (!token) {
    throw new Error("Profile credential unavailable");
  }
  const query = async (document) => {
    const response = await request(GITHUB_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({ query: document }),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    const scopes = (response.headers.get("x-oauth-scopes") || "")
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean);
    // Fail closed if a broad repo/write token is ever configured accidentally.
    if (scopes.length !== 1 || scopes[0] !== "read:user") {
      throw new Error("Profile credential must have only read:user access");
    }
    if (!response.ok) {
      throw new Error("GitHub profile request failed");
    }
    const body = await response.json();
    if (body.errors?.length || body.data?.viewer?.login !== USERNAME) {
      throw new Error("GitHub profile response unavailable");
    }
    return body.data.viewer;
  };

  const profile = await query(PROFILE_QUERY);
  const years = profile.contributionsCollection.contributionYears;
  const currentYear = new Date().getUTCFullYear();
  if (
    !Array.isArray(years) ||
    !years.length ||
    years.length > 150 ||
    years.some(
      (year) => !Number.isInteger(year) || year < 1900 || year > currentYear,
    )
  ) {
    throw new Error("Invalid profile contribution years");
  }
  let totalStars = profile.repositories.nodes.reduce(
    (sum, repo) => sum + repo.stargazerCount,
    0,
  );
  let repositories = profile.repositories;
  const cursors = new Set();
  while (repositories.pageInfo.hasNextPage) {
    const cursor = repositories.pageInfo.endCursor;
    if (typeof cursor !== "string" || cursors.has(cursor)) {
      throw new Error("Invalid repository cursor");
    }
    cursors.add(cursor);
    const page = await query(`query { viewer { login
      repositories(first: 100, privacy: PUBLIC, ownerAffiliations: OWNER, after: ${JSON.stringify(cursor)}) {
        nodes { stargazerCount } pageInfo { hasNextPage endCursor }
      }
    } }`);
    repositories = page.repositories;
    totalStars += repositories.nodes.reduce(
      (sum, repo) => sum + repo.stargazerCount,
      0,
    );
  }

  const fields = `totalCommitContributions totalPullRequestContributions
    totalIssueContributions totalPullRequestReviewContributions
    restrictedContributionsCount contributionCalendar { totalContributions }`;
  const counts = await query(
    `query { viewer { login ${[...new Set(years)]
      .map(
        (year) =>
          `year_${year}: contributionsCollection(from: "${year}-01-01T00:00:00Z", to: "${year}-12-31T23:59:59Z") { ${fields} }`,
      )
      .join("\n")} } }`,
  );
  const total = (field) =>
    [...new Set(years)].reduce((sum, year) => {
      const value = counts[`year_${year}`]?.[field];
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error("Incomplete profile contribution counts");
      }
      return sum + value;
    }, 0);
  const totalContributions = [...new Set(years)].reduce((sum, year) => {
    const value =
      counts[`year_${year}`]?.contributionCalendar?.totalContributions;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Incomplete profile contribution calendar");
    }
    return sum + value;
  }, 0);
  const stats = {
    name: profile.name || USERNAME,
    followers: profile.followers.totalCount,
    totalStars,
    totalCommits: total("totalCommitContributions"),
    totalPRs: total("totalPullRequestContributions"),
    totalIssues: total("totalIssueContributions"),
    totalReviews: total("totalPullRequestReviewContributions"),
    totalContributions,
    contributedTo: 0,
    totalPRsMerged: 0,
    mergedPRsPercentage: 0,
    totalDiscussionsStarted: 0,
    totalDiscussionsAnswered: 0,
    totalPRsAuthored: 0,
    totalPRsCommented: 0,
    totalPRsReviewed: 0,
    totalIssuesAuthored: 0,
    totalIssuesCommented: 0,
    allTimeContributedTo: 0,
  };
  // The profile calendar is authoritative for totals; do not pretend restricted
  // contributions are commits by adding them to the commit count.
  return {
    ...stats,
    restrictedContributions: total("restrictedContributionsCount"),
  };
}

/**
 * Render lifetime profile totals without repository identifiers or raw errors.
 * @returns {Promise<object>} The rendered aggregate card.
 */
export async function generateProfileCard() {
  const stats = await fetchProfileStats(process.env.PROFILE_READ_TOKEN);
  const rank = calculateRank({
    all_commits: true,
    commits: stats.totalCommits,
    prs: stats.totalPRs,
    issues: stats.totalIssues,
    reviews: stats.totalReviews,
    stars: stats.totalStars,
    followers: stats.followers,
    repos: 0,
  });
  return {
    status: "success",
    content: renderStatsCard(
      { ...stats, rank },
      {
        theme: "darcula",
        show_icons: true,
        include_all_commits: true,
        hide: ["contribs"],
        show: ["contributions", "reviews"],
        disable_animations: true,
        number_format: "long",
      },
    ),
  };
}
