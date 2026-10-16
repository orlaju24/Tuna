const locks = new Map<string, number>();

const KILL_KEY = "__kill__";

export function canFire(key: string, cooldownSeconds: number): boolean {
  const now = Date.now();
  const last = locks.get(key) ?? 0;
  if (now - last < cooldownSeconds * 1000) {
    return false;
  }
  locks.set(key, now);
  return true;
}

export function release(key: string): void {
  locks.delete(key);
}

export function canExecuteKill(cooldownSeconds: number): boolean {
  return canFire(KILL_KEY, cooldownSeconds);
}

export function releaseKill(): void {
  release(KILL_KEY);
}

export function positionLockKey(positionId: string): string {
  return `position:${positionId}`;
}
