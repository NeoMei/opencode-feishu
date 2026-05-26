import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join, dirname, basename } from 'path';
import { homedir } from 'os';
import { FeishuConfigSchema } from './config.js';
import type { FeishuConfig } from './types.js';

const DEFAULT_PROFILES_DIR = join(homedir(), '.config', 'opencode', 'feishu-profiles');
const ACTIVE_PROFILE_FILE = join(homedir(), '.config', 'opencode', 'feishu-active-profile');

export interface ProfileInfo {
  name: string;
  path: string;
  config?: FeishuConfig;
  isActive: boolean;
}

export class ProfileManager {
  private profilesDir: string;

  constructor(profilesDir?: string) {
    this.profilesDir = profilesDir || DEFAULT_PROFILES_DIR;
    if (!existsSync(this.profilesDir)) {
      mkdirSync(this.profilesDir, { recursive: true });
    }
  }

  private getProfilePath(name: string): string {
    return join(this.profilesDir, `${name}.json`);
  }

  private readActiveProfile(): string | null {
    try {
      return readFileSync(ACTIVE_PROFILE_FILE, 'utf-8').trim();
    } catch {
      return null;
    }
  }

  private writeActiveProfile(name: string): void {
    const dir = dirname(ACTIVE_PROFILE_FILE);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(ACTIVE_PROFILE_FILE, name);
  }

  private clearActiveProfile(): void {
    try {
      unlinkSync(ACTIVE_PROFILE_FILE);
    } catch {
      // ignore
    }
  }

  list(): ProfileInfo[] {
    const activeName = this.readActiveProfile();
    
    try {
      const files = readdirSync(this.profilesDir);
      return files
        .filter(f => f.endsWith('.json'))
        .map(f => {
          const name = basename(f, '.json');
          const path = join(this.profilesDir, f);
          let config: FeishuConfig | undefined;
          try {
            const content = readFileSync(path, 'utf-8');
            config = FeishuConfigSchema.parse(JSON.parse(content));
          } catch {
            // invalid config
          }
          return {
            name,
            path,
            config,
            isActive: name === activeName,
          };
        });
    } catch {
      return [];
    }
  }

  get(name: string): FeishuConfig | null {
    const path = this.getProfilePath(name);
    if (!existsSync(path)) {
      return null;
    }

    try {
      const content = readFileSync(path, 'utf-8');
      return FeishuConfigSchema.parse(JSON.parse(content));
    } catch {
      return null;
    }
  }

  save(name: string, config: FeishuConfig): void {
    const validated = FeishuConfigSchema.parse(config);
    const path = this.getProfilePath(name);
    const dir = dirname(path);
    
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(path, JSON.stringify(validated, null, 2));
  }

  delete(name: string): boolean {
    const path = this.getProfilePath(name);
    if (!existsSync(path)) {
      return false;
    }

    unlinkSync(path);
    
    // If this was the active profile, clear it
    if (this.readActiveProfile() === name) {
      this.clearActiveProfile();
    }

    return true;
  }

  use(name: string): boolean {
    const config = this.get(name);
    if (!config) {
      return false;
    }

    this.writeActiveProfile(name);
    return true;
  }

  getActive(): { name: string; config: FeishuConfig } | null {
    const activeName = this.readActiveProfile();
    if (!activeName) {
      return null;
    }

    const config = this.get(activeName);
    if (!config) {
      return null;
    }

    return { name: activeName, config };
  }

  rename(oldName: string, newName: string): boolean {
    const oldPath = this.getProfilePath(oldName);
    const newPath = this.getProfilePath(newName);
    
    if (!existsSync(oldPath) || existsSync(newPath)) {
      return false;
    }

    const content = readFileSync(oldPath, 'utf-8');
    writeFileSync(newPath, content);
    unlinkSync(oldPath);

    // Update active profile if needed
    if (this.readActiveProfile() === oldName) {
      this.writeActiveProfile(newName);
    }

    return true;
  }

  clone(sourceName: string, targetName: string): boolean {
    const sourcePath = this.getProfilePath(sourceName);
    const targetPath = this.getProfilePath(targetName);
    
    if (!existsSync(sourcePath) || existsSync(targetPath)) {
      return false;
    }

    const content = readFileSync(sourcePath, 'utf-8');
    writeFileSync(targetPath, content);
    return true;
  }
}
