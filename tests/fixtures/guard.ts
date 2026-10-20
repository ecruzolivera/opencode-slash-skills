import { Plugin } from "@opencode/plugin";
import fs from "node:fs";

// Stop every test prompt before admission. No model call can result from it.
export default Plugin.define({
  id: "slash-skills.smoke-guard",
  async setup(ctx) {
    await ctx.session.hook("prompt", (event) => {
      fs.appendFileSync(process.env.SLASH_TEST_ADMISSIONS!, JSON.stringify(event.prompt) + "\n");
      throw new Error("Smoke test stopped prompt before admission");
    });
  },
});
