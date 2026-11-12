import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// `scripts/tauri-dev.mjs` picks a free port per worktree and passes it here,
// so dev servers in several worktrees don't collide on 1420.
const port = Number(process.env.SKILLS_MANAGER_DEV_PORT) || 1420;

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/target/**", "**/.dev-home/**"],
    },
  },
  test: {
    exclude: [...configDefaults.exclude, "**/.dev-home/**"],
  },
  preview: {
    host: "127.0.0.1",
    port,
    strictPort: true,
  },
});
