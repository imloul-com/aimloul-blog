# Deployment ownership

This repository is infra-agnostic.

- It builds and validates the Hugo site in CI (`.github/workflows/deploy.yml`).
- It publishes static build artifacts to GHCR (`ghcr.io/anasimloul/aimloul-blog-static`) using version tags (`prod-latest`, `dev-latest`, `sha-*`).
- It does not deploy to Cloudflare directly.
- It does not require Cloudflare secrets.

Cloudflare Pages deployment, router deployment, and route/domain mapping are managed in the `cloudflare-infra` repository from the app catalog (`worker/src/app-sources.json`).
