import { defineConfig, markdown } from "sourcey";

export default defineConfig({
  name: "build-preset",
  siteUrl: "https://jonbogaty.com",
  baseUrl: "/build-preset",
  theme: {
    preset: "default",
    colors: {
      primary: "#1d3a2f",
      light: "#3f8f6e",
      dark: "#0e1f18",
    },
    fonts: {
      sans: "system-ui, sans-serif",
      mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
    },
    layout: {
      sidebar: "17rem",
      toc: "18rem",
      content: "46rem",
    },
    css: ["./brand.css"],
  },
  favicon: "./assets/favicon.svg",
  repo: "https://github.com/jbcom/build-preset",
  editBranch: "main",
  editBasePath: "docs",
  prettyUrls: "slash",
  navbar: {
    links: [
      { type: "github", href: "https://github.com/jbcom/build-preset" },
      { type: "npm", label: "npm", href: "https://www.npmjs.com/package/build-preset" },
    ],
  },
  footer: {
    links: [
      {
        type: "link",
        label: "MIT License",
        href: "https://github.com/jbcom/build-preset/blob/main/LICENSE",
      },
      {
        type: "link",
        label: "Security",
        href: "https://github.com/jbcom/build-preset/security/policy",
      },
    ],
  },
  navigation: {
    tabs: [
      {
        tab: "Documentation",
        slug: "",
        source: markdown({
          groups: [
            {
              group: "Getting Started",
              pages: ["introduction", "getting-started"],
            },
            {
              group: "Guides",
              pages: ["vite", "browser-testing", "capacitor", "library-builds"],
            },
            {
              group: "Reference",
              pages: ["API", "ARCHITECTURE"],
            },
            {
              group: "Project",
              pages: ["decisions", "development", "release-history"],
            },
          ],
        }),
      },
    ],
  },
});
