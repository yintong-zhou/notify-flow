import { defineConfig } from "vitepress";

export default defineConfig({
  title: "notify-flow",
  description: "Self-hosted transactional email over plain SMTP, plus opt-in Web Push, for Cloudflare Workers",
  cleanUrls: true,
  srcExclude: ["superpowers/**", "handoff/**", "requirements/**"],
  markdown: {
    // Template placeholders like `{{name}}` in inline code must stay literal, not become Vue interpolations.
    config: (md) => {
      const render = md.renderer.rules.code_inline!;
      md.renderer.rules.code_inline = (...args) => render(...args).replace("<code", "<code v-pre");
    },
  },
  themeConfig: {
    nav: [
      { text: "Home", link: "/" },
      { text: "Documentation", link: "/getting-started", activeMatch: "^/(getting-started|web-app-integration|ai-integration|ai-push|ai-management)" },
      { text: "API Reference", link: "/api-reference", activeMatch: "^/api-reference" },
    ],
    sidebar: [
      {
        text: "Documentation",
        items: [
          { text: "Getting started", link: "/getting-started" },
          {
            text: "Integration guide",
            link: "/web-app-integration",
            items: [
              { text: "Flows and production", link: "/web-app-integration-flows" },
              { text: "Asynchronous sending", link: "/web-app-integration-async" },
              { text: "Event-based sending", link: "/web-app-integration-events" },
              { text: "Web Push", link: "/web-app-integration-push" },
            ],
          },
          { text: "AI integration prompt", link: "/ai-integration-prompt" },
          { text: "AI Web Push prompt", link: "/ai-push-integration-prompt" },
          { text: "AI management page prompt", link: "/ai-management-page-prompt" },
          { text: "Admin dashboard", link: "/admin-dashboard" },
        ],
      },
      {
        text: "API Reference",
        items: [
          { text: "Overview", link: "/api-reference" },
          { text: "Sending", link: "/api-reference-email" },
          { text: "Events and templates", link: "/api-reference-config" },
          { text: "Web Push", link: "/api-reference-push" },
        ],
      },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/yintong-zhou/notify-flow" }],
    search: { provider: "local" },
  },
});
