export interface User {
  id: number;
  name: string;
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export const add = (a: number, b: number): number => a + b;

export class UserStore {
  private users = new Map<number, User>();

  add(user: User): void {
    this.users.set(user.id, user);
  }

  find(id: number): User | undefined {
    return this.users.get(id);
  }
}

export async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status}`);
  }
  return res.json();
}
