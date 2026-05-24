# Vmux

Vmux is a Tauri + React desktop app for controlling local development services from one tmux-style surface.

## What It Manages

- Save services with a name, working directory, command, URL, port, and auto-start flag.
- Start, stop, and restart each service from its pane.
- Show the process id, uptime, port readiness, and recent log output.
- Open a service URL or working directory from the pane metadata.
- Persist service definitions in the app configuration directory.

## Development

```bash
pnpm install
pnpm dev
pnpm tauri:dev
```

## Checks

```bash
pnpm build
pnpm tauri:build
```

## Release Notes

The updater plugin is registered and the release workflow has placeholders for updater signing:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

Set the real GitHub repository in `src-tauri/tauri.conf.json` before publishing update metadata.
Replace the updater `pubkey` placeholder with the public key printed by `pnpm tauri signer generate`;
keep the private key only in GitHub Secrets.
