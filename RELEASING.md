# Releasing

Publishing is a manual step that needs network access and an npm session.

1. Confirm the local gates pass: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.
2. Check the built CLI: `node dist/cli/main.js --version`.
3. Inspect the package contents: `npm pack --dry-run`. The tarball should contain `dist/`, `README.md`, `LICENSE`, and `package.json` only.
4. Log in once: `npm login`.
5. Publish: `npm publish`.
6. Verify: `npm view altiora-agent version`.
7. Smoke test from a clean directory: `npx altiora-agent@<version> --help`.

Notes:

- The npm name is `altiora-agent` because `altiora` is an npm security placeholder; the installed command is `altiora`.
- `publishConfig.access` is `public`; the repository is Apache-2.0.
- Do not publish from a dirty working tree. Tag the release commit after publishing.
