import { Plugin } from "@opencode/plugin/tui";
import fs from "node:fs";

export default Plugin.define({
  id: "slash-skills.smoke-tui",
  setup(ctx) {
    const save = (value) => fs.writeFileSync(process.env.SLASH_TEST_REPORT!, JSON.stringify(value));
    let timer;
    let stopped = false;
    void (async () => {
      try {
        const location = ctx.location ?? ctx.data.location.default();
        await ctx.data.location.command.sync(location);
        const commands = ctx.data.location.command.list(location) ?? [];
        if (!commands.some((c) => c.name === "slash-smoke")) throw new Error("Skill alias was not registered");
        if (commands.some((c) => c.name === "skills")) throw new Error("Built-in collision was not skipped");
        const created = await ctx.client.session.create({ title: "Slash skills smoke", location, agent: "build" });
        const session = created.data ?? created;
        ctx.ui.router.navigate({ type: "session", sessionID: session.id });
        await ctx.client.session.update({ sessionID: session.id,
          permissions: [{ action: "skill", resource: "slash-smoke", effect: "deny" }] });
        try {
          await ctx.client.session.command({ sessionID: session.id, name: "slash-smoke", text: "must deny" });
          throw new Error("Denied skill unexpectedly succeeded");
        } catch (error) {
          if (fs.existsSync(process.env.SLASH_TEST_ADMISSIONS!)) throw new Error("Denied skill reached prompt admission");
          if (String(error).includes("unexpectedly succeeded")) throw error;
        }
        await ctx.client.session.update({ sessionID: session.id,
          permissions: [{ action: "skill", resource: "slash-smoke", effect: "allow" }] });
        try {
          await ctx.client.session.command({ sessionID: session.id, name: "slash-smoke", text: "exact task", delivery: "queue" });
        } catch { /* The admission guard deliberately rejects the prompt. */ }
        const lines = fs.readFileSync(process.env.SLASH_TEST_ADMISSIONS!, "utf8").trim().split("\n");
        const admission = JSON.parse(lines[0]);
        if (lines.length !== 1 || admission.text !== "exact task"
            || !admission.skills?.some((s) => s.id === "slash-smoke")) {
          throw new Error("Native skill attachment or argument forwarding failed");
        }
        // Python types into the real prompt only after this readiness marker.
        save({ ready: true, version: ctx.app.version, permissions: true, nativeAttachment: true });
        timer = setInterval(() => {
          if (stopped) return;
          const text = [];
          function walk(node) {
            if (typeof node.plainText === "string") text.push(node.plainText);
            for (const child of node.getChildren?.() ?? []) walk(child);
          }
          walk(ctx.renderer.root);
          if (text.some((line) => line.includes("Skill: Isolated slash smoke fixture"))) {
            save({ done: true, version: ctx.app.version, autocomplete: true,
              permissions: true, nativeAttachment: true });
            clearInterval(timer);
          }
        }, 100);
      } catch (error) {
        save({ done: true, error: String(error) + "\n" + error.stack });
      }
    })();
    return () => { stopped = true; clearInterval(timer); };
  },
});
