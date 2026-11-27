# Duet for Claude Code

Built mainly to take advantage of the **Claude Duet research-preview promotion**. Eligible accounts can redeem usage-limit resets in Claude’s **Settings → Usage**. Unused promotional resets expire on December 15, 2026. [Claude Duet promotion and eligibility](https://support.claude.com/en/articles/17631495-get-started-with-claude-duet)

This is a small, unofficial project. Expect bugs and rough edges, especially as the Duet preview changes.

Switch an interactive Claude Code session to Duet with `/duet:proxy`. Duet uses its own tools and can read and edit files in your current directory through the **Local Workspace** connector.

## Setup

1. Install Node.js 22 or newer, Claude Code, and ripgrep. On Linux, `node-pty` may also need Python, `make`, and a C++ compiler.
2. Clone the repo and run `npm run setup` from the checkout. Setup installs dependencies and Chromium if needed and links `claude-duet-menu` into `~/.local/bin`.
3. Enter your own public HTTPS MCP URL. You can skip this during setup and enter it when you first enable Duet. See [Host the workspace connector](#host-the-workspace-connector).
4. From the directory you want to share, run `claude-duet-menu` and type `/duet:proxy`. Choose **Sign in to Duet** or enable **Duet with workspace tools** to sign in on first use. Sign in to the Claude account with Duet access. The launcher detects when sign-in is complete.

## Host the workspace connector

Use any reverse proxy or tunnel that can forward a public HTTPS URL on port 443 to the machine running the launcher. For example, forward `https://mcp.example.com/mcp` to `http://127.0.0.1:41331/mcp`. The launcher starts that local listener when you enable Duet. Preserve the POST body and `x-api-key` header. If you choose a different public path, rewrite it to `/mcp` on the local listener. [Claude connector network requirements](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)

Run `claude-duet-menu --setup` to change the URL or local port. The launcher verifies that the host rejects unauthenticated requests and forwards authenticated ones before it registers the connector. Keep your forwarding route running while you use Duet.

## Use it

- Choose **Duet with workspace tools** to share the directory shown in the menu. Choose **Claude** to return to the standard connection and stop sharing the workspace.
- Use **Sign in to Duet** in the menu or run `claude-duet-menu --login` to refresh your sign-in. If you refreshed it while Duet was active, switch to Claude and back to Duet to apply it. Use `claude-duet-menu --browser` to open approvals or attachments.
- Use `claude-duet-menu --continue` or `--resume` to launch an existing conversation. This also restores `/duet:proxy` if you started your session directly in Claude Code. Switching routes keeps the Claude Code session ID and includes recent chat text in the first Duet request.
- Each bridge conversation gets a private Duet channel in the **Claude Code** group. When you enable Duet, the launcher also moves saved active channels that you own into that group.

Duet mode supports text prompts and workspace tools for listing, searching, reading, creating, and editing files. It excludes symlinks and common credential paths. When sharing your home directory, it also excludes hidden paths. Claude Code features such as Remote Control are available on the standard Claude route.

## Configuration

| Variable | Purpose |
| --- | --- |
| `DUET_WORKSPACE` | Override the default workspace directory. |
| `DUET_CHECKS_FILE` | Add named commands with a JSON mapping such as `{"test":["npm","test"]}`. |
| `DUET_CHROME` | Use a specific Chromium executable. |
| `DUET_BROWSER_PORT` | Change the loopback port used by the Duet sign-in and browser windows. |
| `DUET_BIN_DIR` | Change the launcher destination when running setup. |

The launcher generates a fresh workspace key each time you enable Duet. The model proxy binds to loopback with its own key. Sign-in is saved locally in `.duet-auth` with owner-only permissions. Chromium can close once sign-in is complete. Git ignores sign-in data, the browser profile, host settings, and channel mappings.

## Development

Run `npm ci` and `npm test` from the checkout. Tests run locally without a Claude account or public host. The bridge uses Duet’s web endpoints for private channels, messages, and connectors. The timeline integration was informed by [Agent Tincan’s Duet adapter](https://github.com/mvanhorn/agent-tincan/blob/main/docs/adapters/web-agents.md).
