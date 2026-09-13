# Deploy a static instance

The UTXO Pizza instance is [timelock-tool.utxo.pizza](https://timelock-tool.utxo.pizza/), hosted on Cloudflare Pages. This document is also usable for an independent fork. It does not grant access to UTXO Pizza infrastructure or require its account IDs, DNS record IDs or private release tools.

## Build and base path

```bash
npm ci
npm test
npm run docs:check
VITE_BASE_PATH=/ npm run build
```

Publish the contents of `dist/`: HTML, hashed JavaScript/CSS, the secp256k1 WASM asset and provider-specific static headers. Keep WebAssembly files intact and served with `application/wasm`. No project server or node daemon is required.

| Hosting location | Build-process value |
| --- | --- |
| Root domain or custom subdomain, such as the UTXO Pizza site | `VITE_BASE_PATH=/` |
| GitHub project page under `/bitcoin-asset-timelock-tool/` | `VITE_BASE_PATH=/bitcoin-asset-timelock-tool/` |
| Portable relative paths | Omit it; the current config defaults to `./` |

Routes are URL fragments (`#/csv`, `#/cltv`), so they do not need separate server routes. Change the base path for static assets, not the lock-workspace fragments. The config reads `VITE_BASE_PATH` from the build process; exporting it in the shell or provider build environment is explicit and reproducible.

Never pass an OpenAPI key through `VITE_*` variables or commit one to public assets. Users enter their own key in the browser. Configure public endpoint overrides only when deliberately using a trusted endpoint for the selected chain.

## Cloudflare Pages

The existing UTXO Pizza project uses **Direct Upload**, not automatic Git-source deployment. Publishing this GitHub repository alone does not update that site. For your own account, follow Cloudflare's [Direct Upload documentation](https://developers.cloudflare.com/pages/get-started/direct-upload/).

After validating the build, authenticate with Cloudflare using its normal browser flow. A typical Wrangler deployment is:

```bash
npx wrangler login
npx wrangler pages deploy dist --project-name=your-pages-project
```

Use your own project name and review the destination account and environment before confirming. Pin and review deployment tooling in your release environment. Keep API tokens in provider/CLI credential storage, never in this repository or command examples containing real secrets. Direct Upload and Git-integration project setup have different provider constraints; choose deliberately when creating a new project.

Bind a custom domain through the Pages project and make only the required DNS changes. Do not replace unrelated root-domain or wildcard records. Let the provider validate domain ownership and HTTPS before advertising the URL.

### Static headers

[public/_headers](../public/_headers) is copied into `dist/` and interpreted by Cloudflare Pages. It configures MIME-sniffing protection, framing restrictions, no referrer, revalidation for the entry/version files, and immutable caching for hashed assets. It is not a comprehensive CSP or substitute for application security. A different host may ignore `_headers`; configure equivalent headers there if appropriate.

## Optional GitHub Pages

GitHub Pages is an alternative for forks, not the production deployment target for UTXO Pizza. The [Pages workflow](../.github/workflows/deploy-pages.yml) is manual-only so ordinary pushes do not accidentally publish a second site.

1. Enable Pages for the intended repository using **GitHub Actions** as its source.
2. Run **Deploy GitHub Pages** from the Actions tab and choose the appropriate base path. Use `/` for a custom domain or an account root site, and `/repository-name/` for a project site.
3. The workflow installs the locked dependencies, runs local tests/document checks, builds, uploads the artifact and deploys it using a Pages environment.
4. Confirm the deployment URL and both fragments. Enable this workflow only for a repository you intend to host through GitHub Pages.

The deployment job requests `pages: write` and `id-token: write`; normal [CI](../.github/workflows/ci.yml) only needs `contents: read`. The workflow does not require a Cloudflare token and cannot update the Cloudflare production project. See [Vite's GitHub Pages guide](https://vite.dev/guide/static-deploy.html#github-pages) for provider setup.

## Verify before announcing a release

- Inspect the proposed source commit and `dist/` for credentials, private records, signed transactions and unexpected artifacts.
- Record the source commit, dirty-worktree status, build environment, deployment identifier and static-file hashes. Do not label a dirty build as an exact clean-commit release.
- Check HTTPS, MIME types and base-path loading. Open both `#/csv` and `#/cltv` directly, refresh, and inspect narrow-screen layout without connecting a real wallet.
- Keep an identifiable previous deployment for rollback. Never promise rollback can reverse transactions already signed or confirmed on-chain.

The app footer reports a source commit or `unknown`, and explicitly marks uncommitted changes. The UTXO Pizza instance also publishes [release.json](https://timelock-tool.utxo.pizza/release.json) from its release process. That file is not generated by plain `npm run build` and must not be copied from another release as evidence for your build. Private historical source archives and upload scripts are not required to host this repository.

The 2026-09-13 recovery release was deployed before its source was committed as `8fff256`. Its original build marker remains accurate for that build even after GitHub publication. Documentation-only commits update the repository guides without replacing the running static application. Use the [changelog](CHANGELOG.md) for source changes and the [validation record](VALIDATION.md#deployment-and-source-publication) for the recorded deployment checks.

## Records do not move with a deployment

LocalStorage is scoped by origin. A fork domain, GitHub Pages origin and the upstream site have separate records and keys. Updating the same origin normally preserves them; changing origin does not migrate them. Do not tell users to clear site data as an upgrade step. [Public recovery](PUBLIC-BACKUP.md) can reconstruct references to existing BATL outputs on another origin, but it cannot migrate API keys or resume lost pending signed chains. Preserve those private records before changing where users access the app.

For an update on the same origin, reload the application, connect the original wallet on its network, then click `Verify recovered record` for each existing recovered reference. Session verification is intentionally discarded on reload and wallet changes, while saved references remain. Hard-refreshing an old tab loads the current application; re-importing the same JSON or deleting storage is not an upgrade requirement.
