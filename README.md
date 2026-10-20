# OpenCode slash skills

Use `/skill-id your task` to select a skill in OpenCode's slash autocomplete.
On submission, this server plugin checks skill permission and attaches the skill
natively. It does not ask the model to call the skill tool, generate command
files, or patch OpenCode.

Verified with OpenCode 2.0.32. No dependency installation or build is required
when loaded by OpenCode. Node.js is needed only for the unit tests.

## Install

Clone the repository to a persistent directory:

```sh
git clone https://github.com/ecruzolivera/opencode-slash-skills.git
```

Add this directory to the existing `plugins` array in
`~/.config/opencode/opencode.json` or `opencode.jsonc`. Preserve other entries:

```json
{
  "plugins": ["/path/to/opencode-slash-skills"]
}
```

This is a server plugin, not a CLI-only plugin. Do not add it to `cli.json`.
Valid configuration edits are normally reloaded. No service restart is needed.

## Use

```text
/frontend-design build a compact settings screen
/grilling
```

- Names use exact skill IDs, not frontmatter display names.
- All skills in OpenCode's resolved registry are considered, including global,
  built-in, project, and explicit-only skills. Existing skill precedence applies.
- Selecting an alias keeps it in the prompt so you can add your task. Submission
  loads the skill using the native attachment API.
- A bare `/skill-id` loads the skill with empty task text. The plugin does not
  invent a task. The skill may ask you for details.
- Only the first slash name is a command. Other slash words in its arguments are
  ordinary text, not additional skill invocations.
- Existing files, agent mentions, skill attachments, delivery mode, agent, and
  model selection are preserved. An already attached skill is not added twice.
- `@skill-id` and the built-in `/skills` picker continue working.
- Inline `/skill-id` completion inside a sentence is not supported.

The plugin calls `permission.assert` with action `skill` and the selected
session agent before submitting a prompt. Denial or rejection prevents prompt
submission. This is stricter than explicit native skill selection in 2.0.32.
If the session agent changes during approval, submission fails and you must retry.
Permission checking and submission are not atomic across clients; a change
after the final check remains possible through the current host API.

## Collisions and refresh

Detected server commands and known built-in TUI names take priority. Conflicting
skills are skipped and reported in the server log. IDs outside the conservative
`[a-zA-Z0-9][a-zA-Z0-9._-]*` pattern are skipped, never renamed.

The server cannot enumerate third-party TUI slash names. Reserve those explicitly
if necessary using the plugin's object form:

```json
{
  "plugins": [{
    "package": "/path/to/opencode-slash-skills",
    "options": { "reservedNames": ["my-tui-command"] }
  }]
}
```

Collision protection is best-effort, not a universal guarantee. OpenCode 2.0.32
does not expose add-if-absent registration, command ownership, or a complete
cross-client TUI command inventory. An earlier command hidden under an alias
may change without changing public registry metadata. Such a change cannot
always be detected. Use `/skills` or `@` to select a conflicting skill.

The plugin listens for location-scoped `skill.updated` and `command.updated`
events. Refreshes are serialized and coalesced. Its aliases are temporarily
withdrawn before reading foreign commands, then rebuilt in place. Aliases can
briefly disappear during refresh. Fingerprints prevent self-generated events
from causing reload loops. Stream failure triggers reconnection and a fresh scan.

If registry reads fail, the plugin withdraws its aliases and logs an error.
A later registry update retries discovery. It does not scan directories, add
filesystem watchers, or poll remote skill catalogs.

Diagnostics use the `[slash-skills]` prefix in OpenCode's server log. They report
skipped IDs and operational errors, not task text or skill content.

## Verification

```sh
npm test
npm run test:integration
```

The integration test needs Linux, Python 3, and OpenCode on `PATH`. It starts a
private server and real TUI under a temporary home without your credentials or
configuration. It verifies slash autocomplete, permission denial and approval,
and the native skill attachment at prompt admission. A test-only hook rejects
every prompt before admission, so no model request occurs. Only its isolated
process group is stopped during cleanup.

Full model execution after skill loading is intentionally not tested. Neither
test restarts or sends prompts to your existing sessions.

## Remove

Remove only this plugin's entry from the server configuration. Plugin cleanup
aborts its event subscription and disposes its command registration. No generated
commands, skill files, permissions, or desktop settings need removal.

Source: <https://github.com/ecruzolivera/opencode-slash-skills>.
The plugin is not published to npm. Use a local checkout as described above.

## API references

- <https://opencode.ai/v2/docs/build/plugins>
- <https://opencode.ai/v2/docs/skills>
- <https://github.com/anomalyco/opencode/blob/v2.0.32/packages/core/src/session/command.ts>
- <https://github.com/anomalyco/opencode/blob/v2.0.32/packages/plugin/src/promise/command.ts>
- <https://github.com/anomalyco/opencode/blob/v2.0.32/packages/plugin/src/permission.ts>
