import fs from 'fs';
import path from 'path';

export interface SkillDefinition {
  id: string;
  name?: string;
  system_prompt?: string;
  enable_tools?: string[];
  disable_tools?: string[];
}

export interface SkillsManifest {
  skills?: SkillDefinition[];
}

export interface LoadedSkills {
  systemPrompts: string[];
  enabledTools?: Set<string>;
  disabledTools: Set<string>;
}

const MANIFEST_PATHS = [
  '/workspace/skills/manifest.json',
  '/workspace/project/skills/manifest.json',
  '/workspace/config/skills.json',
];

export function loadSkillsManifest(): LoadedSkills {
  let manifest: SkillsManifest | null = null;
  for (const candidate of MANIFEST_PATHS) {
    if (fs.existsSync(candidate)) {
      try {
        manifest = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as SkillsManifest;
        break;
      } catch {
        // ignore malformed manifest
      }
    }
  }

  const systemPrompts: string[] = [];
  const disabledTools = new Set<string>();
  const enabledTools = new Set<string>();
  let hasEnableList = false;

  for (const skill of manifest?.skills || []) {
    if (skill.system_prompt) systemPrompts.push(skill.system_prompt);
    if (skill.disable_tools) {
      for (const tool of skill.disable_tools) {
        disabledTools.add(tool);
      }
    }
    if (skill.enable_tools && skill.enable_tools.length > 0) {
      hasEnableList = true;
      for (const tool of skill.enable_tools) {
        enabledTools.add(tool);
      }
    }
  }

  return {
    systemPrompts,
    enabledTools: hasEnableList ? enabledTools : undefined,
    disabledTools,
  };
}
