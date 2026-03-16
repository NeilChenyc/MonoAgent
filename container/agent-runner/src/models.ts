import fs from 'fs';
import path from 'path';
import { getModel, type Model } from '@mariozechner/pi-ai';

export interface ModelRoute {
  id: string;
  provider: string;
  model: string;
  tags?: string[];
  fallback?: string[];
}

export interface ModelsConfig {
  default: string;
  routes: ModelRoute[];
}

const DEFAULT_CONFIG: ModelsConfig = {
  default: 'general',
  routes: [
    {
      id: 'general',
      provider: 'openai',
      model: 'gpt-4o-mini',
      tags: ['general', 'fast'],
      fallback: ['code'],
    },
    {
      id: 'code',
      provider: 'openai',
      model: 'gpt-4o-mini',
      tags: ['code'],
    },
  ],
};

export function loadModelsConfig(): ModelsConfig {
  const configPath = path.join('/workspace/config', 'models.json');
  if (!fs.existsSync(configPath)) return DEFAULT_CONFIG;
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as ModelsConfig;
    if (!raw.routes?.length || !raw.default) return DEFAULT_CONFIG;
    return raw;
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function selectRoute(config: ModelsConfig, hint?: string): ModelRoute {
  const byTag = hint
    ? config.routes.find((r) => r.tags?.includes(hint))
    : undefined;
  const byId = hint ? config.routes.find((r) => r.id === hint) : undefined;
  const primary = byId || byTag || config.routes.find((r) => r.id === config.default);
  return primary || config.routes[0];
}

export function getRouteById(config: ModelsConfig, id: string): ModelRoute | undefined {
  return config.routes.find((r) => r.id === id);
}

export function resolveModel(route: ModelRoute): Model<any> {
  return getModel(route.provider, route.model);
}
