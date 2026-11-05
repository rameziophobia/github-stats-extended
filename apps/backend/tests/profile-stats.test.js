import { describe, expect, it, vi } from "vitest";

import { fetchProfileStats, generateProfileCard } from "../profile-stats.js";

const profile = {
  login: "rameziophobia",
  name: "Ramez Weissa",
  followers: { totalCount: 57 },
  contributionsCollection: { contributionYears: [2025, 2026] },
  repositories: {
    nodes: [{ stargazerCount: 108 }],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
};
const year = (commits, prs, restricted = 0) => ({
  totalCommitContributions: commits,
  totalPullRequestContributions: prs,
  totalIssueContributions: 2,
  totalPullRequestReviewContributions: 3,
  restrictedContributionsCount: restricted,
  contributionCalendar: { totalContributions: commits + prs + 5 + restricted },
});
const response = (viewer, scope = "read:user") => ({
  ok: true,
  headers: new Headers({ "x-oauth-scopes": scope }),
  json: async () => ({ data: { viewer } }),
});

describe("read-only aggregate profile queries", () => {
  it("renders lifetime counts without private metadata from upstream payloads", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(response(profile))
      .mockResolvedValueOnce(
        response({
          login: profile.login,
          privateMetadata: "private-repository-secret",
          year_2025: year(3000, 250),
          year_2026: year(2000, 300),
        }),
      );
    vi.stubGlobal("fetch", request);
    vi.stubEnv("PROFILE_READ_TOKEN", "test-profile-token");
    try {
      const result = await generateProfileCard();
      expect(result.status).toBe("success");
      const document = new DOMParser().parseFromString(
        result.content,
        "image/svg+xml",
      );
      expect(
        document.querySelector('[data-testid="commits"]').textContent,
      ).toBe("5000");
      expect(document.querySelector('[data-testid="prs"]').textContent).toBe(
        "550",
      );
      expect(result.content).not.toContain("(last year)");
      expect(result.content).not.toContain("private-repository-secret");
      expect(result.content).not.toContain("test-profile-token");
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
  it("counts each contribution year once and requests only GitHub aggregates", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(response(profile))
      .mockResolvedValueOnce(
        response({
          login: profile.login,
          year_2025: year(3000, 250),
          year_2026: year(2000, 300),
        }),
      );
    const stats = await fetchProfileStats("test-profile-token", request);
    expect(stats).toMatchObject({
      totalCommits: 5000,
      totalPRs: 550,
      totalIssues: 4,
      totalReviews: 6,
      totalStars: 108,
      totalContributions: 5560,
    });
    expect(request).toHaveBeenCalledTimes(2);
    for (const [url, options] of request.mock.calls) {
      expect(url).toBe("https://api.github.com/graphql");
      expect(options.method).toBe("POST");
      expect(options.redirect).toBe("error");
      const query = JSON.parse(options.body).query;
      expect(query).not.toMatch(
        /\b(mutation|nameWithOwner|email|body|commitContributionsByRepository|pullRequests)\b/,
      );
      expect(query).not.toContain("test-profile-token");
    }
    expect(request.mock.calls[1][1].body).toContain("2025-01-01T00:00:00Z");
    expect(request.mock.calls[1][1].body).toContain("2026-12-31T23:59:59Z");
  });

  it.each(["repo, read:user", "user", "read:user, gist", "", "read:org"])(
    "refuses credentials outside the exact read:user scope: %s",
    async (scope) => {
      const request = vi.fn().mockResolvedValue(response(profile, scope));
      await expect(fetchProfileStats("test-token", request)).rejects.toThrow(
        "only read:user",
      );
      expect(request).toHaveBeenCalledOnce();
    },
  );

  it("refuses another user's credential", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(response({ ...profile, login: "someone-else" }));
    await expect(fetchProfileStats("test-token", request)).rejects.toThrow(
      "response unavailable",
    );
    expect(request).toHaveBeenCalledOnce();
  });

  it("does not forward private upstream error content", async () => {
    const request = vi.fn().mockResolvedValue({
      ...response(profile),
      json: async () => ({ errors: [{ message: "private repo / secret" }] }),
    });
    await expect(fetchProfileStats("test-token", request)).rejects.toThrow(
      "GitHub profile response unavailable",
    );
  });

  it("rejects malformed years before building a query", async () => {
    const request = vi.fn().mockResolvedValue(
      response({
        ...profile,
        contributionsCollection: {
          contributionYears: ["2025) { repositories { name }"],
        },
      }),
    );
    await expect(fetchProfileStats("test-token", request)).rejects.toThrow(
      "Invalid profile contribution years",
    );
    expect(request).toHaveBeenCalledOnce();
  });

  it("never misclassifies restricted contributions as commits", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          ...profile,
          contributionsCollection: { contributionYears: [2026] },
        }),
      )
      .mockResolvedValueOnce(
        response({ login: profile.login, year_2026: year(100, 10, 50) }),
      );
    expect(await fetchProfileStats("test-token", request)).toMatchObject({
      totalCommits: 100,
      totalContributions: 165,
      restrictedContributions: 50,
    });
  });

  it("fails on partial counts instead of publishing misleading totals", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(response(profile))
      .mockResolvedValueOnce(
        response({ login: profile.login, year_2025: year(100, 10) }),
      );
    await expect(fetchProfileStats("test-token", request)).rejects.toThrow(
      "Incomplete profile contribution",
    );
  });
});
