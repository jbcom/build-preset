import { execFileSync } from "node:child_process";

const REPO = "jbcom/build-preset";

const ruleset = {
  name: "main-integrity",
  target: "branch",
  enforcement: "active",
  conditions: {
    ref_name: { include: ["refs/heads/main"], exclude: [] },
  },
  rules: [
    { type: "deletion" },
    { type: "non_fast_forward" },
    {
      type: "pull_request",
      parameters: {
        required_approving_review_count: 0,
        dismiss_stale_reviews_on_push: true,
        require_code_owner_review: false,
        require_last_push_approval: false,
        require_extra_approval_for_unattributed_changes: false,
        required_review_thread_resolution: true,
        allowed_merge_methods: ["merge"],
      },
    },
    {
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: [
          { context: "CI / gate" },
          // The live check run is named "title" (the workflow is "Lint PR").
          // Required contexts bind to the check-run name, not workflow/name.
          { context: "title" },
          { context: "Repository Policy / gate" },
          { context: "Dependency Review / gate" },
        ],
      },
    },
  ],
  bypass_actors: [],
};

// required_approving_review_count is 0 deliberately: this repo is
// agent-maintained, and requiring human review would either block the
// agent entirely or require it to review its own PRs, which reviews
// nothing. Fork-safety comes from (a) GitHub never granting a
// pull_request-triggered workflow repo secrets, (b)
// strict_required_status_checks_policy forcing the PR branch to be
// up-to-date with main and every listed check green on that exact
// commit, and (c) non_fast_forward + deletion blocking history rewrites on
// main itself. The bypass list is deliberately empty: trusted agents satisfy
// policy; they do not bypass it.

const existing = JSON.parse(
  execFileSync("gh", ["api", `repos/${REPO}/rulesets`], { encoding: "utf8" }),
);
// Upgrade the former name in place so its legacy linear-history rule cannot
// remain layered over this merge-commit policy.
const current =
  existing.find((r) => r.name === ruleset.name) ??
  existing.find((r) => r.name === "main-protection");

const endpoint = current ? `repos/${REPO}/rulesets/${current.id}` : `repos/${REPO}/rulesets`;
const method = current ? "PUT" : "POST";

execFileSync("gh", ["api", endpoint, "--method", method, "--input", "-"], {
  input: JSON.stringify(ruleset),
  stdio: ["pipe", "inherit", "inherit"],
});

console.log(`Ruleset "${ruleset.name}" applied to ${REPO}.`);
