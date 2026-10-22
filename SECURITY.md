# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems.

Use GitHub's private vulnerability reporting on this repository: **Security → Report a vulnerability**. The report reaches the maintainers only. You will get an acknowledgement within 7 days and a status update when the fix ships.

If private reporting is unavailable in your GitHub account, open an issue that says only "security report, please contact me" without details; a maintainer will reach out.

## What is in scope

- The desktop application, the mobile client, ph-agent and the built-in MCP server.
- Human-in-the-loop approvals: any way for an agent to run a risky action without the configured approval.
- Remote Control: pairing, encryption and device permissions.
- Secret storage and the audit log.

## What ProjectHub promises

- Local-first: the application sends nothing anywhere except the services you configure (model providers, your own relay, Telegram) and the update check.
- No telemetry and no trackers in the application or on the website.
- Paid modules (`ee/`) check a license file offline; there is no licensing call-home.

## Supported versions

Pre-release versions (0.x) receive fixes in the next release only. Report against the latest release.
