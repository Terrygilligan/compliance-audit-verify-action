# Sovereign Compliance Sample App

A minimal reference repository demonstrating end-to-end GitHub Actions integration with the Sovereign Compliance Engine.

## Quick Setup Guide

1. **Mint a Scoped API Key:** Log into your compliance portal (`app.compliance-audit.eu`), navigate to API Keys, and mint a dedicated key with `assess` and `read` permissions for your repository.
2. **Configure Repository Secrets:** Add the following secrets to your GitHub repository settings:
   - `COMPLIANCE_API_KEY`: Your generated API key.
   - `COMPLIANCE_TENANT_ID`: Your tenant identifier.
3. **Enable GitHub Pages:** In your repo settings under **Pages**, set the build source to **GitHub Actions**.
4. **Open a Pull Request:** Modify a file or push a commit. The workflow will automatically deploy the site to GitHub Pages and run the compliance verification action against it.
5. **Review Results:** Check the **Actions** tab for the step summary or view the automated Markdown comment posted directly to your Pull Request.

## Notes & honest limitations

- **PR scans validate the deployed URL.** GitHub Pages serves the latest published build, so a PR-triggered scan audits what is (or will be) live — not an isolated preview of the PR diff. In a real repository, pass your preview-deployment URL (Vercel / Firebase Hosting preview channel / Netlify deploy preview) as `target-url` instead.
- **Forked PRs** run with a read-only `GITHUB_TOKEN` and cannot deploy Pages — the comment step no-ops cleanly and the step summary is still produced.
- **After extraction:** when `verify-action/` moves to its own repository, update the `upload-pages-artifact` path in `compliance-test.yml` from `verify-action/sample-app/site` to `sample-app/site`.
- The audit endpoint is capped at **10 runs/hour per caller IP** and requires a key on a tier with the `audit` feature (demo tier or above).
