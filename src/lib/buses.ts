import type { LatLng } from "@/lib/geo";

export type DirectionName = "inbound" | "outbound";

export type Stop = {
  id: string;
  name: string;
  lat: number;
  lon: number;
};

export type DirectionRoute = {
  direction: DirectionName;
  originName: string;
  destinationName: string;
  stops: Stop[];
  segments: LatLng[][];
};

export type Watch = DirectionRoute & {
  lineId: string;
  lineName: string;
};

export type LiveVehicle = {
  id: string;
  lineId: string;
  lineName: string;
  direction: DirectionName;
  destination: string;
  bearing: number;
  source: "gps" | "estimate";
  lat?: number;
  lon?: number;
  naptanId?: string;
  seconds?: number;
  delayed?: boolean;
};

export type LineAlert = {
  lineId: string;
  severity: "minor" | "major";
  title: string;
  detail: string;
};

export type LiveResult = {
  vehicles: LiveVehicle[];
  mode: "gps" | "estimate";
  keyError?: string;
  note?: string;
  alerts: LineAlert[];
};

export type FavouriteStop = {
  id: string;
  name: string;
  towards: string;
  letter: string;
};

export const POPULAR = ["11", "25", "38", "73", "149", "SL1"] as const;

export function watchKey(watch: Pick<Watch, "lineId" | "direction">) {
  return `${watch.lineId}:${watch.direction}`;
}

export function escapeHtml(value: string) {
  const amp = "&" + "amp;";
  const lt = "&" + "lt;";
  const gt = "&" + "gt;";
  const quot = "&" + "quot;";
  return value.replaceAll("&", amp).replaceAll("<", lt).replaceAll(">", gt).replaceAll('"', quot);
}
