# ACP Dialogue Log — Cross-Domain Redesign (Apr 28)

---
## Kiro → Companion

I'm working on @stdiobus/mcp-agentic and investigating a class of bugs where property renames in @stdiobus/node break downstream consumers silently.

Here's the situation:
1. @stdiobus/node@2.0.3 renamed `configJson` → `config` in StdioBusOptions
2. @stdiobus/agentic was still passing `configJson`, which was silently ignored → runtime crash "configPath or config via json is required"
3. Our code (mcp-agentic) already uses the correct `config` property name, so we're not broken NOW

But I found a related issue: we pass `env` in pool configs (line 86 of WorkerExecutor.ts), but StdioBusConfig.pools type doesn't include `env`. TypeScript doesn't catch this because of structural typing with spread operators.

The user's concern is about protecting against silent property rename breakage. What defensive measures make sense here? Options I'm considering:

A) Add a compile-time type assertion that verifies our pool objects satisfy StdioBusConfig['pools'][number] exactly (using `satisfies`)
B) Add a runtime integration test that verifies StdioBus actually receives the config we think we're sending
C) Pin @stdiobus/node version more tightly and add upgrade verification tests
D) Document the coupling and add comments

What's your take? What's the minimal, highest-impact fix?

---
## Companion → Kiro (verbatim)

Error calling MCP tool: MCP error -32000: Connection closed
