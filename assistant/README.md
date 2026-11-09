# Analyst assistant

Server-side LLM assistance for the analyst, under one rule: **the model narrates and navigates
structured evidence; it never scores, never judges and never runs on the endpoint.**

**Built: case narratives.** From a case page, an analyst generates the readable story of the case.
`evidence-graph.ts` builds an allowlisted evidence graph from the case's detections, `llm-client.ts`
sends it to an OpenAI-compatible chat-completions endpoint (a self-hosted Ollama by default, see the
`LLM_*` variables in [configuration](../docs/configuration.md#case-narratives)), and `prompt.ts` holds
the versioned system prompt. Every claim cites the record it comes from, the output is labeled with
its provider, and a narrative is marked stale when the case's evidence changes.

Cases themselves come from the `group-detections` scheduled job, a server-side heuristic: detections
of the same agent within 30 minutes and with related MITRE ATT&CK techniques form one case.

Planned:

- **Natural-language navigation.** A question such as "hosts where this hash ran last week",
  compiled to a hunt or graph query the analyst sees and edits before running it.
- **Triage drafting.** Suggested next steps and playbook choices, always as proposals for the
  analyst to act on; the assistant holds no execution authority.

Tenant data never trains shared models.

Code: this directory, `app/api/cases/[id]/narrative/`, `lib/case-grouping.ts`. Tests:
`tests/integration/case-narrative-regenerate.test.ts`, `group-detections-cron.test.ts`.
