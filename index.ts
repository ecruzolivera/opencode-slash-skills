import { Plugin } from "@opencode/plugin";
import { setupAliases } from "./src/aliases.mjs";

export default Plugin.define({
  id: "eco.slash-skills",
  setup: setupAliases,
});
