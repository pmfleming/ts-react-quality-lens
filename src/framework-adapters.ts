import type { Config, FrameworkDetails, ImportRecord, ModuleRecord, SourceFileRecord } from "./types.js";

type FrameworkProject = {
  sourceFiles: SourceFileRecord[];
  testFiles: SourceFileRecord[];
  modules: Array<Pick<ModuleRecord, "file">>;
  imports: ImportRecord[] | unknown[];
};

type FrameworkAdapter = {
  name: string;
  detect: (config: Config, project: FrameworkProject) => Partial<FrameworkDetails>;
};

const FRAMEWORK_ADAPTERS: FrameworkAdapter[] = [
  {
    name: "next",
    detect: (_config, project) => {
      const files = fileSet(project);
      const appRoutes = [...files].filter((file) => /(?:^|\/)app\/.*(?:page|layout|route|loading|error)\.[jt]sx?$/.test(file));
      const pagesRoutes = [...files].filter((file) => /(?:^|\/)pages\/.*\.[jt]sx?$/.test(file));
      return {
        routes: [
          ...appRoutes.map((file) => ({ kind: "next_app_route", file })),
          ...pagesRoutes.map((file) => ({ kind: "next_pages_route", file })),
        ],
        conventions: {
          next_app_router: appRoutes.length > 0,
          next_pages_router: pagesRoutes.length > 0,
        },
      };
    },
  },
  {
    name: "remix",
    detect: (_config, project) => {
      const remixRoutes = [...fileSet(project)].filter((file) => /(?:^|\/)routes\/.*\.[jt]sx?$/.test(file));
      return {
        routes: remixRoutes.map((file) => ({ kind: "remix_route", file })),
        conventions: { remix_routes: remixRoutes.length > 0 },
      };
    },
  },
  {
    name: "storybook",
    detect: (_config, project) => {
      const stories = [...fileSet(project)].filter((file) => /\.stories\.[jt]sx?$/.test(file));
      return {
        stories,
        conventions: { storybook: stories.length > 0 },
      };
    },
  },
  {
    name: "react-client-server",
    detect: (_config, project) => {
      const clientComponents = project.sourceFiles
        .filter((file) => file.text.trimStart().startsWith('"use client"') || file.text.trimStart().startsWith("'use client'"))
        .map((file) => file.relativePath);
      const serverOnlySignals = project.sourceFiles
        .filter((file) => /\b(?:fs|node:fs|process\.env)\b/.test(file.text))
        .map((file) => file.relativePath);
      return {
        client_components: clientComponents,
        server_only_signals: serverOnlySignals,
      };
    },
  },
];

export function detectFrameworkDetails(config: Config, project: FrameworkProject): FrameworkDetails {
  const base: FrameworkDetails = {
    framework: config.framework,
    routes: [],
    stories: [],
    client_components: [],
    server_only_signals: [],
    conventions: {},
  };
  return FRAMEWORK_ADAPTERS.reduce((details, adapter) => mergeDetails(details, adapter.detect(config, project)), base);
}

function mergeDetails(details: FrameworkDetails, patch: Partial<FrameworkDetails>): FrameworkDetails {
  return {
    framework: details.framework,
    routes: [...details.routes, ...(patch.routes ?? [])],
    stories: [...details.stories, ...(patch.stories ?? [])],
    client_components: [...details.client_components, ...(patch.client_components ?? [])],
    server_only_signals: [...details.server_only_signals, ...(patch.server_only_signals ?? [])],
    conventions: { ...details.conventions, ...(patch.conventions ?? {}) },
  };
}

function fileSet(project: FrameworkProject): Set<string> {
  return new Set<string>(project.sourceFiles.map((file) => file.relativePath));
}
