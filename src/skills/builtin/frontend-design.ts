import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";

const getDesignSystemGuidelinesTool = defineTool({
  name: "get_frontend_design_guidelines",
  description: "Get modern frontend design principles, color token conventions, typography guidelines, and UI anti-patterns to avoid generic templated looks.",
  parameters: Type.Object({
    category: Type.Optional(Type.String({ description: "Category to get: 'all' | 'typography' | 'colors' | 'layout' | 'anti-patterns'" })),
  }),
  async execute(args) {
    const guidelines = {
      philosophy: "Distinctive, intentional visual design. Make deliberate, opinionated choices about palette, typography, and layout specific to the brief. Avoid templated AI-slop.",
      typography: {
        principles: "Typography carries personality. Stick to one or two distinct families. Line lengths under 80 characters. Visible weight & spacing scale.",
        antiPatterns: ["Accenting a single word in bold/color in headlines", "ALL CAPS for labels", "Meaningless numbered markers (01/02) when not a sequence"],
      },
      colors: {
        principles: "Define a compact token system (4-6 named hex values). High contrast, dark obsidian/slate base, electric subtle accents.",
        paletteExample: {
          bg: "#080c14",
          surface: "#0f172a",
          border: "rgba(255, 255, 255, 0.08)",
          accent: "#38bdf8",
          text: "#f8fafc",
          muted: "#94a3b8",
        },
      },
      layout: {
        principles: "Visual structure is information. Structural devices (borders, dividers) must encode information rather than decorate. Motion should answer human action.",
      },
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(guidelines, null, 2),
        },
      ],
    };
  },
});

export const FrontendDesignTools = defineExtension({
  name: "frontend-design",
  tools: [getDesignSystemGuidelinesTool],
});
