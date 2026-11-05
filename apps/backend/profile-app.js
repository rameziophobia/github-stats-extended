import {
  logger,
  renderError,
} from "@stats-organization/github-readme-stats-core";
import express from "express";

import { generateProfileCard } from "./profile-stats.js";

// This deployment publishes aggregate counts for one profile. Do not mount the
// upstream router here: /api/pin and other endpoints can disclose private repo
// metadata when a read-only private-repository token is configured.
export const PROFILE_OPTIONS = Object.freeze({
  username: "rameziophobia",
  show_icons: "true",
  theme: "darcula",
});

const CACHE_MS = 60 * 60 * 1000;

// Upstream request errors can contain Axios headers (including Authorization)
// or GitHub response bodies. Operational logs must not receive these objects.
logger.log = () => {};
logger.error = () => console.error("GitHub profile stats request failed");

/**
 * Construct the aggregate-only HTTP boundary with an injectable card generator.
 * @returns {import("express").Express} The restricted HTTP application.
 */
export function createProfileApp(generateCard = generateProfileCard) {
  const app = express();
  app.disable("x-powered-by");
  app.set("query parser", false);

  let cachedCard;
  let cachedAt = 0;
  let pending;

  const loadCard = async () => {
    if (cachedCard && Date.now() - cachedAt < CACHE_MS) {
      return cachedCard;
    }
    if (!pending) {
      pending = (async () => {
        try {
          // Never pass request parameters or a caller-selected token upstream.
          const result = await generateCard({ ...PROFILE_OPTIONS });
          if (result.status !== "success") {
            return cachedCard;
          }
          cachedCard = result.content;
          cachedAt = Date.now();
          return cachedCard;
        } catch {
          logger.error();
          return cachedCard;
        }
      })().finally(() => {
        pending = undefined;
      });
    }
    return pending;
  };

  app.use(async (req, res) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    });
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.set("Allow", "GET, HEAD").status(405).end();
      return;
    }
    const url = new URL(req.originalUrl, "https://localhost");
    if (url.pathname === "/api/status/up") {
      res.json({ status: "up" });
      return;
    }
    if (url.pathname !== "/api" && url.pathname !== "/api/") {
      res.status(404).end();
      return;
    }
    const seen = new Set();
    for (const [key, value] of url.searchParams) {
      if (
        !Object.hasOwn(PROFILE_OPTIONS, key) ||
        PROFILE_OPTIONS[key] !== value ||
        seen.has(key)
      ) {
        res.status(400).end();
        return;
      }
      seen.add(key);
    }
    const card = await loadCard();
    if (card) {
      res.set("Cache-Control", "public, max-age=3600, s-maxage=3600");
      res.type("image/svg+xml").send(card);
      return;
    }
    // Do not publish upstream messages, error objects, or repository names.
    res
      .status(503)
      .type("image/svg+xml")
      .send(
        renderError({
          message: "Profile stats temporarily unavailable",
          secondaryMessage: "Please try again later",
          renderOptions: { theme: "darcula", show_repo_link: false },
        }),
      );
  });
  return app;
}
