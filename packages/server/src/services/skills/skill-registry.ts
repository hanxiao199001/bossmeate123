import type { ISkill } from "./base-skill.js";

class SkillRegistryClass {
  private skills = new Map<string, ISkill>();

  register(skill: ISkill): void {
    if (this.skills.has(skill.name)) {
      throw new Error(`Skill "${skill.name}" already registered`);
    }
    this.skills.set(skill.name, skill);
    console.log(`Skill registered: ${skill.name} (${skill.displayName})`);
  }

  get(name: string): ISkill | undefined {
    return this.skills.get(name);
  }

  list(): Array<{ name: string; displayName: string; description: string }> {
    return Array.from(this.skills.values()).map((s) => ({
      name: s.name,
      displayName: s.displayName,
      description: s.description,
    }));
  }

  has(name: string): boolean {
    return this.skills.has(name);
  }
}

export const SkillRegistry = new SkillRegistryClass();
