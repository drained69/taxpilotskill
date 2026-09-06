# Submitting TaxPilot to the Binance Skills Hub

The `skill/` directory in this repo is a self-contained, MIT-licensed skill
package that follows the Binance Skills Hub layout. This file lists the exact
steps to publish it.

## Prerequisites

- A GitHub account
- Node.js 22 or higher installed locally (Skills Hub CLI requirement)

## Steps

1. **Fork the hub**

   Open <https://github.com/binance/binance-skills-hub> and click **Fork**.

2. **Clone your fork**

   ```bash
   git clone https://github.com/<your-username>/binance-skills-hub.git
   cd binance-skills-hub
   git checkout -b feature/taxpilot
   ```

3. **Copy this skill into the hub**

   From this TaxPilot repo:

   ```bash
   mkdir -p /path/to/binance-skills-hub/skills/binance/taxpilot
   cp -r skill/* /path/to/binance-skills-hub/skills/binance/taxpilot/
   ```

   The final layout in the hub should be:

   ```
   binance-skills-hub/
   └── skills/
       └── binance/
           └── taxpilot/
               ├── SKILL.md
               ├── LICENSE
               └── references/
                   ├── tool-registry.md
                   ├── normalization.md
                   ├── tax-methodology.md
                   ├── decision-verbs.md
                   └── output-format.md
   ```

4. **Verify the frontmatter parses**

   Every skill's `SKILL.md` must have valid YAML frontmatter. Sanity-check:

   ```bash
   head -20 skills/binance/taxpilot/SKILL.md
   ```

   The first four lines should be `---`, `name: taxpilot`, `description: |`, and continued description text; ending with `---` before the first heading.

5. **Commit and push**

   ```bash
   git add skills/binance/taxpilot
   git commit -m "feat(taxpilot): add read-only US crypto tax report skill"
   git push origin feature/taxpilot
   ```

6. **Open a pull request**

   Navigate to your fork on GitHub, click **Compare & pull request**. Target
   branch: `main`. Suggested title and body:

   **Title:** `feat(taxpilot): add read-only US crypto tax report skill`

   **Body:**

   > TaxPilot computes an audit-ready US Form 8949 + ordinary-income report
   > from a user's Binance account using the Agent OS MCP server. Strictly
   > read-only — pulls spot trades, deposits, withdrawals, converts,
   > transfers, USD-M/COIN-M futures, and margin history in parallel.
   >
   > **Guarantees:**
   > - Never places trades or moves funds — the tool registry explicitly
   >   forbids every write verb.
   > - Never invents a valuation — events without a derivable USD value go
   >   into a Tax Inbox for user resolution.
   > - Never guesses transfer ownership — the user resolves each ambiguous
   >   deposit/withdrawal via one of the five decision verbs.
   >
   > **Scope of v1:** US federal, FIFO, 2025 tax year, encoded to Rev. Proc.
   > 2024-28's per-account lot rule. Non-US, non-FIFO, wash sales, and hard
   > forks are explicitly out of scope and refused with clear messaging.
   >
   > Ships with a reference implementation (web dashboard) at
   > https://github.com/<your-username>/taxpilot — the skill is self-contained
   > and does not require the reference implementation to run.

7. **Await review**

   Binance maintainers review and merge. Users can then install with:

   ```bash
   npx skills add https://github.com/binance/binance-skills-hub/tree/main/skills/binance/taxpilot
   ```

## What lives here vs. in the reference implementation

| Concern                            | Skill (`skill/`)  | Reference impl (rest of this repo) |
| ---------------------------------- | ----------------- | ---------------------------------- |
| Methodology (what to do)           | ✔                 | ✔ (as executable code)             |
| MCP tool registry                  | ✔ (documented)    | ✔ (as JS array)                    |
| Normalization rules                | ✔ (documented)    | ✔ (as JS functions)                |
| Tax engine (FIFO, holding period)  | ✔ (documented)    | ✔ (as JS functions)                |
| OAuth + session + storage          | ✗ (agent's job)   | ✔ (server.js + src/auth/)          |
| Web UI                             | ✗                 | ✔ (public/)                        |
| Persistence layer                  | ✗ (agent's job)   | ✔ (src/storage.js)                 |

The skill teaches an agent how to compute the report inside its own MCP
session. The reference implementation is a hosted web app for users who
prefer a dashboard over a chat interface. Both share the same methodology.
