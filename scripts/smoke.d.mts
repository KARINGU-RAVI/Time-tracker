export interface SmokeResult {
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}
export function runSmoke(
  base: string,
  options?: { local?: boolean; origin?: string },
): Promise<{ results: SmokeResult[]; ok: boolean }>;
