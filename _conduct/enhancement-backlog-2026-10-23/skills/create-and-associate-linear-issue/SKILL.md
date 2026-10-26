# Create and Associate Linear Issue

Provide the shared Linear mutation layer for parent skills and agent workflows. Resolve the correct destination, create or reuse one issue, associate required artifacts, recover partial writes, and verify the resulting Linear state.

## Handoff contract

Require the parent workflow to provide:

- `operation`: `create_or_reuse` or `associate_existing`;
- `purpose`: why the issue or association is needed;
- `destinationHints`: explicit project, team, repository, product, or existing Linear context;
- `desiredState`: semantic intent such as `backlog` or `active_development`;
- `issue`: title and evidence-based description when creating;
- `existingIssue`: issue identifier when associating with an existing issue;
- `associations`: required documents, commits, pull requests, deployments, or other references;
- `completionRequirements`: facts and links that must be verified before success.

Do not start Linear mutations when the handoff is missing information required to choose a unique destination or truthful state.

## 1. Resolve the destination

Use the Linear connector for every Linear read and write.

Resolve the project and team in this order:

1. project or team explicitly named by the user;
2. association already established in the current task or supplied issue;
3. repository or product ownership that maps to one Linear project and team.

Use the selected project's associated team. Never choose by name similarity alone. If the project is missing, spans multiple plausible teams, or conflicts with the handoff, ask the user before creating or moving anything.

## 2. Prevent duplicates and unsafe retries

- If `existingIssue` is supplied, retrieve it and verify its team, project, and state before associating anything.
- Before creating, search the resolved project and team for an equivalent active issue.
- If a likely duplicate exists, ask whether to reuse it or create a distinct issue; do not silently duplicate or merge work.
- After a timeout or ambiguous mutation response, read Linear state before retrying.
- Once an issue identifier is observed, preserve and reuse it for the rest of the workflow.

## 3. Create or reuse the issue

For `create_or_reuse`:

- Create one concise, outcome-oriented issue in the resolved team and attach it to the resolved project.
- Map `desiredState` to the team's truthful workflow state.
  - For `backlog`, use Backlog; if unavailable, use the nearest unstarted or triage state and disclose the substitution.
  - For `active_development`, use the team's active state such as In Progress.
- Do not invent priority, assignee, estimate, cycle, deadline, or completion state.
- Create the issue before documents or references that require its identifier.
- Do not place links in the initial description until their targets exist.

For `associate_existing`, do not create another issue.

Capture the issue identifier and direct URL.

## 4. Create and associate artifacts

Process associations in dependency order.

### Documents

- Create each required Linear document only after the issue identifier exists.
- Include the issue identifier and a backlink to the issue in every document.
- Associate each document with the issue using Linear's supported relationship or a visible issue link.
- After all documents exist, update the issue description or a clearly visible comment with their direct links.
- If Linear cannot create or associate the required documents, stop and report the capability limitation. Do not substitute local files or claim completion.

### Existing references

For commits, pull requests, deployments, or existing documents:

- Verify the supplied reference exists when the connector exposes that information.
- Link it to the existing issue without changing unrelated issue fields.
- Never invent a hash, URL, deployment result, or review state.

## 5. Recover partial writes

If the issue exists but an association fails:

- keep the same issue identifier;
- record or preserve an explicit `association incomplete` status in the issue when possible;
- retry only the missing association after checking current Linear state;
- do not recreate successful documents or duplicate issue comments;
- report the partial result and exact blocker if recovery cannot complete.

## 6. Verify and return a receipt

Read the issue and every required association back through Linear. Confirm:

- issue identifier and URL;
- team and project;
- actual workflow state and any disclosed substitution;
- issue title and essential description;
- every required association and backlink;
- no unresolved partial-write marker;
- every parent-supplied completion requirement.

Return a structured receipt containing those facts, plus assumptions, substitutions, and anything not verified. Do not report success until all blocking completion requirements pass.

## Integrity rules

- Preserve the parent workflow's authorization boundaries; this skill does not authorize implementation, commits, pushes, deployment, assignments, or dates.
- Keep issue content evidence-based and consistent with associated artifacts.
- Do not expose secrets, tokens, private logs, customer-sensitive information, or unnecessary personal data.
- Never fabricate destination mappings, issue identifiers, links, states, associations, or verification results.