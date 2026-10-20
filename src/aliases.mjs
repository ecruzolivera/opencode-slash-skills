// Client-only command names are not included in the server command registry.
// Reserved conservatively across routes, rather than only when currently enabled.
export const BUILTIN_NAMES = new Set(`
  sessions resume continue new clear open projects project models agents mcps
  variants thinking effort connect highlights settings status update pair web
  restart reload debug themes help exit quit q rename timeline fork undo redo
  compact summarize share unshare export copy editor skills worktrees cd
  stash stash-pop stash-list diff plugins terminal terminals shell btw
`.trim().split(/\s+/));

export function entries(response) {
  if (!response || !Array.isArray(response.data)) {
    throw new Error("Expected an OpenCode registry response with a data array");
  }
  return response.data;
}

function signature(skills, commands) {
  const fields = (items, key) => items.map((item) => [item[key], item.description ?? ""])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify([fields(skills, "id"), fields(commands, "name")]);
}

export function planAliases(skills, commands, reserved = []) {
  const names = new Set([...BUILTIN_NAMES, ...reserved, ...commands.map((item) => item.name)]);
  const aliases = [];
  const skipped = [];
  const seen = new Set();
  for (const skill of skills) {
    // Exact IDs only. Normalization could select a different skill or command.
    if (typeof skill.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(skill.id)) {
      skipped.push({ id: skill.id, reason: "unsupported slash name" });
    } else if (names.has(skill.id)) {
      skipped.push({ id: skill.id, reason: "command name reserved" });
    } else if (!seen.has(skill.id)) {
      seen.add(skill.id);
      aliases.push({ id: skill.id, description: skill.description ?? skill.name ?? skill.id });
    }
  }
  return { aliases, skipped };
}

export async function invokeSkill(ctx, id, { sessionID, prompt, delivery }, isLive = () => true) {
  if (!isLive()) throw new Error("Slash skills plugin is no longer active");
  const skills = entries(await ctx.skill.list());
  if (!skills.some((skill) => skill.id === id)) throw new Error(`Skill no longer available: ${id}`);
  const session = await ctx.session.get({ sessionID });
  await ctx.permission.assert({
    sessionID, agent: session.agent, action: "skill", resources: [id], save: [id],
  });
  const current = await ctx.session.get({ sessionID });
  if (current.agent !== session.agent) {
    throw new Error("Session agent changed during skill approval. Please retry the command.");
  }
  if (!isLive()) throw new Error("Slash skills plugin was disabled during approval");
  // The server already stripped the command name. Leave text and attachment
  // offsets unchanged. Native preparation resolves the current skill content.
  const attached = [...(prompt.skills ?? [])];
  if (!attached.some((skill) => skill.id === id)) attached.push({ id });
  await ctx.session.prompt({ ...prompt, sessionID, skills: attached, delivery });
}

export async function setupAliases(ctx) {
  const reserved = ctx.options?.reservedNames ?? [];
  if (!Array.isArray(reserved) || reserved.some((name) => typeof name !== "string")) {
    throw new Error("reservedNames must be an array of slash names without the leading /");
  }
  let active = true;
  let aliases = [];
  let settled;
  let timer;
  let pending = false;
  let running;
  let stream;
  const controller = new AbortController();
  const report = (message) => console.warn(`[slash-skills] ${message}`);
  const registration = await ctx.command.transform((editor) => {
    for (const alias of aliases) {
      editor.add({
        name: alias.id,
        description: `Skill: ${alias.description}`,
        execute: (input) => invokeSkill(ctx, alias.id, input, () => active),
      });
    }
  });

  async function snapshot() {
    const [skills, commands] = await Promise.all([ctx.skill.list(), ctx.command.list()]);
    return { skills: entries(skills), commands: entries(commands) };
  }

  async function refresh() {
    const visible = await snapshot();
    if (!active || signature(visible.skills, visible.commands) === settled) return;
    // Withdraw our own definitions before inspecting collisions, including
    // earlier definitions that our old aliases may have hidden.
    aliases = [];
    await ctx.command.reload();
    const foreign = await snapshot();
    if (!active) return;
    const plan = planAliases(foreign.skills, foreign.commands, reserved);
    aliases = plan.aliases;
    await ctx.command.reload();
    const final = await snapshot();
    // Do not mark a skill update racing this rebuild as already handled.
    settled = signature(foreign.skills, final.commands);
    if (signature(final.skills, final.commands) !== settled) pending = true;
    if (plan.skipped.length) report(`Skipped aliases: ${JSON.stringify(plan.skipped)}`);
  }

  function schedule() {
    if (!active) return;
    pending = true;
    if (running || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void drain().catch((error) => report(`Refresh failed: ${error.message}`));
    }, 100);
  }

  async function drain() {
    if (running) return running;
    running = (async () => {
      while (active && pending) {
        pending = false;
        try {
          await refresh();
        } catch (error) {
          // Do not keep aliases whose collision state could not be checked.
          const hadAliases = aliases.length > 0;
          aliases = [];
          settled = undefined;
          // At most one failure-induced reload. Subsequent failures with an
          // empty contribution must not emit another self-triggering event.
          if (hadAliases) await ctx.command.reload();
          pending = false;
          throw error;
        }
      }
    })();
    try {
      await running;
    } finally {
      running = undefined;
      if (pending) schedule();
    }
  }

  function relevant(event) {
    if (!["skill.updated", "command.updated"].includes(event.type)) return false;
    const location = event.location;
    return !location || (location.directory === ctx.location.directory
      && location.workspaceID === ctx.location.workspaceID);
  }

  async function listen() {
    // Public subscriptions have no automatic reconnection. Reconnect only on
    // failure, then resnapshot because events during disconnect are lost.
    while (active) {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type === "server.connected" || relevant(event)) schedule();
        }
      } catch (error) {
        if (!active) return;
        report(`Registry event stream disconnected: ${error.message}`);
      }
      if (!active) return;
      await new Promise((resolve) => {
        const done = () => {
          clearTimeout(wait);
          controller.signal.removeEventListener("abort", done);
          resolve();
        };
        const wait = setTimeout(done, 1000);
        controller.signal.addEventListener("abort", done, { once: true });
      });
      schedule();
    }
  }

  async function dispose() {
    active = false;
    pending = false;
    clearTimeout(timer);
    controller.abort();
    await Promise.allSettled([running, stream]);
    aliases = [];
    await registration.dispose();
  }

  try {
    stream = listen();
    pending = true;
    await drain();
    return dispose;
  } catch (error) {
    await dispose();
    throw error;
  }
}
