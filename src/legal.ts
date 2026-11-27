import { Router } from "express";
import { env } from "./config.ts";
import { AuthError } from "./auth/provider.ts";
import { hashMatcher } from "./safety/hash-match.ts";

export const termsVersion = "2026-11-28";

export const termsClauses = [
  { id: "3.1", title: "Minimum age" },
  { id: "5.1", title: "Illegal content" },
  { id: "5.2", title: "Harassment and threats" },
  { id: "5.3", title: "Hate" },
  { id: "5.4", title: "Violence and glorification of violence" },
  { id: "5.5", title: "Sexual content and nudity" },
  { id: "5.6", title: "Self-harm" },
  { id: "5.7", title: "Spam and manipulation" },
  { id: "5.8", title: "Misleading information" },
  { id: "5.9", title: "Impersonation" },
  { id: "5.10", title: "Privacy of others" },
  { id: "5.11", title: "Intellectual property" },
  { id: "5.12", title: "AI-generated content" },
  { id: "6.2", title: "Ban evasion and misuse of the service" },
] as const;

export const termsClauseIds = termsClauses.map((clause) => clause.id) as [string, ...string[]];

export const reasonClause: Record<string, string> = {
  illegal: "5.1",
  harassment: "5.2",
  hate: "5.3",
  violence: "5.4",
  sexual: "5.5",
  self_harm: "5.6",
  spam: "5.7",
  misinformation: "5.8",
  impersonation: "5.9",
  ai_generated: "5.12",
};

export const legalCategories = [
  "child_sexual_abuse",
  "terrorism",
  "threats",
  "incitement",
  "insult_defamation",
  "unconstitutional_symbols",
  "privacy_violation",
  "intellectual_property",
  "fraud",
  "youth_protection",
  "other",
] as const;

export function contactAddresses() {
  return {
    privacy: env.PRIVACY_EMAIL ?? env.OPERATOR_EMAIL ?? null,
    abuse: env.ABUSE_EMAIL ?? env.OPERATOR_EMAIL ?? null,
  };
}

const router = Router();

router.get("/operator", (_req, res) => {
  if (!env.OPERATOR_NAME || !env.OPERATOR_ADDRESS || !env.OPERATOR_EMAIL)
    throw new AuthError(503, "operator_not_configured");
  res.set("Cache-Control", "public, max-age=300");
  res.json({
    name: env.OPERATOR_NAME,
    address: env.OPERATOR_ADDRESS.split("|").map((line) => line.trim()).filter(Boolean),
    email: env.OPERATOR_EMAIL,
    hashMatching: hashMatcher() !== null,
    contacts: contactAddresses(),
  });
});

router.get("/terms", (_req, res) => {
  res.json({ version: termsVersion, clauses: termsClauses, legalCategories });
});

export default router;
