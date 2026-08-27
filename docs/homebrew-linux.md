# Linuxbrew installation

Teleco's initial Homebrew target is Linuxbrew through a custom Tap. The Formula installs immutable application code under `libexec`; instance secrets remain under `~/.config/teleco/instances` and are never removed by `brew upgrade` or `brew uninstall`.

## Build a local Formula

```bash
pnpm install --frozen-lockfile
pnpm package:homebrew
HOMEBREW_NO_INSTALL_FROM_API=1 brew install --build-from-source ./release/Formula/teleco.rb
brew test teleco
```

The local Formula uses a checksummed `file://` release archive. For a Tap release, generate the same artifact with an immutable GitHub Release URL:

```bash
pnpm package:homebrew -- --url https://github.com/MetaRed0401/teleco/releases/download/v0.1.0/teleco-0.1.0.tar.gz
```

Upload the generated archive first, then copy `release/Formula/teleco.rb` to `MetaRed0401/homebrew-tap/Formula/teleco.rb`.

## Configure and run

```bash
teleco instance add first
teleco instance list
teleco service install first
teleco service start first
teleco service status first
```

Bot tokens use hidden terminal input. For automation, pipe only the token through stdin and use `--token-stdin` together with `--allowed-users`; do not place tokens in command arguments.

Existing repository environment files can be imported without deleting the originals:

```bash
teleco instance import /path/to/teleco/.env.first first
```

To migrate every `.env` and `.env.<instance>` file in an existing checkout, preview the detected instances and
confirm the migration interactively:

```bash
teleco instance migrate /path/to/teleco
```

Use `--yes` only for a reviewed non-interactive migration. The command retains each legacy file, writes a private
`.teleco-backup` copy beside it, and rolls back files created by the current run if migration fails.

## Published release contents

The Homebrew source archive contains compiled `dist/` JavaScript, the three scripts required at install or runtime,
systemd units, package metadata, the lockfile, and user documentation. It does not contain the TypeScript `src/`,
tests, TODO files, release-building scripts, local configuration, or secrets. The Formula itself is published
separately in the Tap. When the GitHub repository is public, packaging source such as
`scripts/build-homebrew-release.mjs` and `packaging/homebrew/teleco.rb.in` remains visible in that source repository
even though it is not duplicated in the Homebrew archive.

Homebrew installations update through `brew upgrade teleco`. `teleco service update first` performs that upgrade and then restarts the selected idle instance. Use `--force` only when intentionally interrupting active work.

Run `teleco doctor` after configuring services. Online diagnostics verify private config permissions, workspace access,
the installed Homebrew version, Codex CLI authentication and app-server availability, the systemd user bus, runtime and
instance service health, and conflicts with the legacy single-instance service. `teleco doctor --offline` limits checks
to the local package and filesystem and is used by the Formula test.

## Linux container troubleshooting

If `curl https://api.telegram.org` works but Teleco reports Telegram request timeouts under Node.js 24, test the instance with:

```bash
NODE_OPTIONS=--no-network-family-autoselection teleco run --instance first
```

Some container networks allow the selected IPv4 route but fail Node's IPv4/IPv6 connection racing. When the test succeeds, add `NODE_OPTIONS=--no-network-family-autoselection` to that instance environment. Keep this as an environment-specific override rather than a global default.
