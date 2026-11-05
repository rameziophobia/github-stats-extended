import supertest from "supertest";
import { describe, expect, it, vi } from "vitest";

import { PROFILE_OPTIONS, createProfileApp } from "../profile-app.js";

const svg =
  "<svg xmlns='http://www.w3.org/2000/svg'><text>Aggregate stats</text></svg>";
const card = () =>
  vi.fn().mockResolvedValue({ status: "success", content: svg });

describe("private profile deployment boundary", () => {
  it("serves the existing README URL using only fixed server-side options", async () => {
    const generate = card();
    const res = await supertest(createProfileApp(generate))
      .get("/api?username=rameziophobia&show_icons=true&theme=darcula")
      .expect(200)
      .expect("Content-Type", /image\/svg\+xml/)
      .expect("X-Content-Type-Options", "nosniff");
    expect(res.body.toString()).toBe(svg);
    expect(generate).toHaveBeenCalledExactlyOnceWith(PROFILE_OPTIONS);
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it.each([
    "/api/pin?username=rameziophobia&repo=private-repo",
    "/api/top-langs?username=rameziophobia",
    "/api/gist?id=private-gist",
    "/api/wakatime-proxy?username=rameziophobia",
    "/api/status/pat-info",
    "/api/authenticate",
    "/frontend",
    "/api%2Fpin",
  ])(
    "blocks alternate endpoints before fetching private data: %s",
    async (url) => {
      const generate = card();
      await supertest(createProfileApp(generate)).get(url).expect(404);
      expect(generate).not.toHaveBeenCalled();
    },
  );

  it.each([
    "username=someone-else",
    "username=rameziophobia&repo=secret",
    "owner=private-org",
    "username=rameziophobia&username=someone-else",
    "username[]=rameziophobia",
    "show=discussions_started",
    "include_all_commits=true",
    "theme=dark",
    "pat=secret",
    "cache_seconds=0",
  ])(
    "rejects query-based probes before fetching private data: %s",
    async (query) => {
      const generate = card();
      await supertest(createProfileApp(generate))
        .get(`/api?${query}`)
        .expect(400);
      expect(generate).not.toHaveBeenCalled();
    },
  );

  it("rejects writes and exposes only a credential-free liveness check", async () => {
    const generate = card();
    const app = createProfileApp(generate);
    await supertest(app).post("/api").send({ repo: "secret" }).expect(405);
    const res = await supertest(app).get("/api/status/up").expect(200);
    expect(res.body).toEqual({ status: "up" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("never publishes upstream error details or credentials", async () => {
    const secret = "test-private-token-and-repository";
    const generate = vi.fn().mockResolvedValue({
      status: "error - temporary",
      content: secret,
      error: { message: secret },
    });
    const res = await supertest(createProfileApp(generate))
      .get("/api")
      .expect(503)
      .expect("Cache-Control", "no-store");
    expect(res.body.toString()).not.toContain(secret);
    expect(res.body.toString()).toContain("temporarily unavailable");
  });

  it("coalesces concurrent requests, caches aggregates and preserves the last good card", async () => {
    let resolve;
    const generate = vi.fn().mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const app = createProfileApp(generate);
    const requests = [supertest(app).get("/api"), supertest(app).get("/api")];
    const responses = Promise.all(requests);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    resolve({ status: "success", content: svg });
    expect((await responses).every((res) => res.status === 200)).toBe(true);
    await supertest(app).get("/api").expect(200);
    expect(generate).toHaveBeenCalledOnce();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 3_600_001);
    generate.mockRejectedValueOnce(new Error("private error details"));
    try {
      const res = await supertest(app).get("/api").expect(200);
      expect(res.body.toString()).toBe(svg);
    } finally {
      clock.mockRestore();
    }
  });
});
