# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 1.x     | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability in `@stdiobus/mcp-agentic`, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please email: **raman@stdiobus.com**

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will acknowledge receipt within 48 hours and provide a timeline for a fix within 5 business days.

## Security Practices

This project follows these security practices:

- **No secrets in code** — All credentials are passed via configuration at runtime, never hardcoded
- **Provider SDK isolation** — AI provider SDKs are peer/optional dependencies; credentials are passed via `ProviderConfig.credentials` at construction time, never read from `process.env` after initialization
- **stdout reserved** — stdout is exclusively for the MCP wire protocol; all logging goes to stderr
- **Input validation** — All MCP tool inputs are validated via Zod schemas before processing
- **Backpressure** — Concurrent request limiting prevents resource exhaustion
- **Dependency auditing** — Automated weekly dependency audits via GitHub Actions
- **CodeQL analysis** — Static analysis runs on every push to main and weekly
