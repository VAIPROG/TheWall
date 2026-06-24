/** Charity (Bluemarble-style) config shapes. Field aliases (frameRate/
 *  frameSpeed/startTime) are normalised in decode.ts. */
export interface CharityEntry {
  name?: string;
  sources?: string[];
  x: number;
  y: number;
  frameWidth?: number | null;
  frameHeight?: number | null;
  frameCount?: number;
  secondsPerFrame?: number;
  frameRate?: number;
  frameSpeed?: number;
  startTimestamp?: number;
  startTime?: number;
  looping?: boolean;
}
export interface CharityConfig {
  faction?: string;
  contact?: string;
  templates: CharityEntry[];
  whitelist?: string[];
}
