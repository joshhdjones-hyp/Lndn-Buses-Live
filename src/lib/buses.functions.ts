import { createServerFn } from "@tanstack/react-start";
import type { DirectionName, DirectionRoute, LiveResult, LiveVehicle, Stop } from "@/lib/buses";
import type { LatLng } from "@/lib/geo";

const LINE_RE = /^[A-Za-z]{0,3}\d{1,4}[A-Za-z]?$/;
const KEY_RE = /^[A-Za-z0-9_-]{10,160}$/;

type LookupOk = {
  ok: true;
  lineId: string;
  lineName: string;
  directions: DirectionRoute[];
};

type LookupFail = { ok: false; error: string };

function cleanLine(input: unknown) {
  const raw =
    typeof input === "object" && input && "lineId" in input ? String((input as { lineId: unknown }).lineId) : "";
  return raw.trim().toUpperCase().replace(/\s+/g, "");
}

function namedEntity(name: string) {
  return "&" + name + ";";
}

function decodeText(value: string) {
  return value
    .replaceAll(namedEntity("harr"), "↔")
    .replaceAll(namedEntity("quot"), '"')
    .replaceAll(namedEntity("#39"), "'")
    .replaceAll(namedEntity("apos"), "'")
    .replaceAll(namedEntity("nbsp"), " ")
    .replaceAll(namedEntity("amp"), "&")
    .replace(/\s+/g, " ")
    .trim();
}

function asSegments(raw: unknown): LatLng[][] {
  if (typeof raw !== "string" || raw.length < 2) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const segments: LatLng[][] = [];
  const walk = (node: unknown) => {
    if (!Array.isArray(node) || node.length === 0) return;
    if (typeof node[0] === "number" && typeof node[1] === "number") return;
    if (Array.isArray(node[0]) && typeof node[0][0] === "number") {
      const line: LatLng[] = [];
      for (const pt of node) {
        if (Array.isArray(pt) && typeof pt[0] === "number" && typeof pt[1] === "number") {
          line.push([pt[1], pt[0]]);
        }
      }
      if (line.length > 1) segments.push(line);
      return;
    }
    for (const child of node) walk(child);
  };
  walk(parsed);
  return segments;
}

function stopsFrom(sequence: { stopPoint?: unknown }): Stop[] {
  if (!Array.isArray(sequence.stopPoint)) return [];
  const stops: Stop[] = [];
  for (const stop of sequence.stopPoint) {
    if (!stop || typeof stop !== "object") continue;
    const row = stop as { id?: unknown; name?: unknown; lat?: unknown; lon?: unknown };
    const lat = Number(row.lat);
    const lon = Number(row.lon);
    const id = String(row.id ?? "");
    const name = decodeText(String(row.name ?? "Stop"));
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const prev = stops[stops.length - 1];
    if (prev && prev.id === id) continue;
    stops.push({ id, name, lat, lon });
  }
  return stops;
}

function tflUrl(path: string, apiKey?: string) {
  const url = new URL(`https://api.tfl.gov.uk${path}`);
  if (apiKey) url.searchParams.set("app_key", apiKey);
  return url;
}

function optionalKey(input: unknown) {
  if (!input || typeof input !== "object" || !("apiKey" in input)) return "";
  const value = (input as { apiKey: unknown }).apiKey;
  const apiKey = typeof value === "string" ? value.trim() : "";
  if (apiKey && !KEY_RE.test(apiKey)) throw new Error("That key doesn't look right.");
  return apiKey;
}

async function loadDirection(lineId: string, direction: DirectionName, apiKey?: string): Promise<DirectionRoute | null> {
  let response = await fetch(tflUrl(`/Line/${encodeURIComponent(lineId)}/Route/Sequence/${direction}`, apiKey), {
    signal: AbortSignal.timeout(12_000),
  });
  if (apiKey && (response.status === 401 || response.status === 403)) {
    response = await fetch(tflUrl(`/Line/${encodeURIComponent(lineId)}/Route/Sequence/${direction}`), {
      signal: AbortSignal.timeout(12_000),
    });
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("TfL didn't answer. Try again in a moment.");
  const body = (await response.json()) as {
    lineId?: string;
    lineName?: string;
    lineStrings?: unknown;
    stopPointSequences?: { stopPoint?: unknown }[];
  };
  const sequence = body.stopPointSequences?.[0];
  const stops = sequence ? stopsFrom(sequence) : [];
  if (stops.length < 2) return null;
  let segments = asSegments(body.lineStrings);
  if (segments.length === 0) {
    segments = [stops.map((stop) => [stop.lat, stop.lon] as LatLng)];
  }
  return {
    direction,
    originName: stops[0].name,
    destinationName: stops[stops.length - 1].name,
    stops,
    segments,
  };
}

export const lookupRoute = createServerFn({ method: "POST" })
  .validator((input: unknown): { lineId: string; apiKey?: string } => {
    const lineId = cleanLine(input);
    if (!LINE_RE.test(lineId)) {
      throw new Error("Use a route number like 25, N8 or SL1.");
    }
    const apiKey = optionalKey(input);
    return { lineId, apiKey: apiKey || undefined };
  })
  .handler(async ({ data }): Promise<LookupOk | LookupFail> => {
    try {
      const [outbound, inbound] = await Promise.all([
        loadDirection(data.lineId, "outbound", data.apiKey),
        loadDirection(data.lineId, "inbound", data.apiKey),
      ]);
      const directions = [outbound, inbound].filter((row): row is DirectionRoute => row !== null);
      if (directions.length === 0) {
        return { ok: false, error: `No London bus route ${data.lineId}.` };
      }
      return { ok: true, lineId: data.lineId, lineName: data.lineId, directions };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Couldn't load that route.";
      return { ok: false, error: message };
    }
  });

type WatchQuery = {
  lineId: string;
  lineName: string;
  direction: DirectionName;
  destinationName: string;
  stopIds: string[];
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
};

type LiveInput = { apiKey?: string; watches: WatchQuery[] };

function watchQuery(input: unknown): LiveInput {
  if (!input || typeof input !== "object") throw new Error("Missing routes.");
  const raw = input as { apiKey?: unknown; watches?: unknown };
  const apiKey = typeof raw.apiKey === "string" ? raw.apiKey.trim() : "";
  if (apiKey && !KEY_RE.test(apiKey)) throw new Error("That key doesn't look right.");
  if (!Array.isArray(raw.watches) || raw.watches.length === 0) throw new Error("Add a route first.");
  const watches = raw.watches.slice(0, 8).map((item) => {
    const row = item as Partial<WatchQuery>;
    const lineId = String(row.lineId ?? "")
      .trim()
      .toUpperCase();
    const direction = row.direction === "inbound" ? "inbound" : "outbound";
    if (!LINE_RE.test(lineId)) throw new Error("Bad route.");
    const nums = [row.minLat, row.minLon, row.maxLat, row.maxLon].map(Number);
    if (nums.some((n) => !Number.isFinite(n))) throw new Error("Bad map bounds.");
    return {
      lineId,
      lineName: String(row.lineName ?? lineId).slice(0, 8),
      direction,
      destinationName: String(row.destinationName ?? "").slice(0, 80),
      stopIds: Array.isArray(row.stopIds) ? row.stopIds.map(String).slice(0, 250) : [],
      minLat: nums[0],
      minLon: nums[1],
      maxLat: nums[2],
      maxLon: nums[3],
    } satisfies WatchQuery;
  });
  return { apiKey, watches };
}

type Arrival = {
  vehicleId: string;
  naptanId: string;
  direction: string;
  bearing: number;
  destinationName: string;
  timeToStation: number;
  lineName: string;
};

async function fetchArrivals(lineId: string, apiKey?: string): Promise<{ rows: Arrival[]; keyError?: string }> {
  let keyError: string | undefined;
  let response = await fetch(tflUrl(`/Line/${encodeURIComponent(lineId)}/Arrivals`, apiKey), {
    signal: AbortSignal.timeout(12_000),
  });
  if (apiKey && (response.status === 401 || response.status === 403)) {
    keyError = "TfL rejected that key. Countdown positions are still on.";
    response = await fetch(tflUrl(`/Line/${encodeURIComponent(lineId)}/Arrivals`), {
      signal: AbortSignal.timeout(12_000),
    });
  }
  if (!response.ok) return { rows: [], keyError };
  const rows = (await response.json()) as {
    vehicleId?: string;
    naptanId?: string;
    direction?: string;
    bearing?: string;
    destinationName?: string;
    timeToStation?: number;
    lineName?: string;
  }[];
  if (!Array.isArray(rows)) return { rows: [], keyError };
  return {
    keyError,
    rows: rows
      .map((row) => ({
        vehicleId: String(row.vehicleId ?? ""),
        naptanId: String(row.naptanId ?? ""),
        direction: String(row.direction ?? ""),
        bearing: Number(row.bearing) || 0,
        destinationName: decodeText(String(row.destinationName ?? "")),
        timeToStation: Number(row.timeToStation),
        lineName: String(row.lineName ?? lineId),
      }))
      .filter((row) => row.vehicleId && row.naptanId && Number.isFinite(row.timeToStation)),
  };
}

function estimatesFor(watch: WatchQuery, arrivals: Arrival[]): LiveVehicle[] {
  const stops = new Set(watch.stopIds);
  const best = new Map<string, Arrival>();
  for (const arrival of arrivals) {
    if (arrival.direction !== watch.direction) continue;
    if (!stops.has(arrival.naptanId)) continue;
    const prev = best.get(arrival.vehicleId);
    if (!prev || arrival.timeToStation < prev.timeToStation) best.set(arrival.vehicleId, arrival);
  }
  return [...best.values()].map((arrival) => ({
    id: `${watch.lineId}-${watch.direction}-${arrival.vehicleId}`,
    lineId: watch.lineId,
    lineName: arrival.lineName || watch.lineName,
    direction: watch.direction,
    destination: arrival.destinationName || watch.destinationName,
    bearing: arrival.bearing,
    source: "estimate" as const,
    naptanId: arrival.naptanId,
    seconds: arrival.timeToStation,
  }));
}

export const liveBuses = createServerFn({ method: "POST" })
  .validator(watchQuery)
  .handler(async ({ data }): Promise<LiveResult> => {
    const lineIds = [...new Set(data.watches.map((watch) => watch.lineId))];
    const arrivalLists = await Promise.all(
      lineIds.map(async (lineId) => [lineId, await fetchArrivals(lineId, data.apiKey || undefined)] as const),
    );
    const arrivals = new Map(arrivalLists.map(([lineId, result]) => [lineId, result.rows]));
    const keyError = arrivalLists.map(([, result]) => result.keyError).find(Boolean);

    const vehicles: LiveVehicle[] = [];
    for (const watch of data.watches) {
      vehicles.push(...estimatesFor(watch, arrivals.get(watch.lineId) ?? []));
    }

    return { vehicles, mode: "estimate", keyError };
  });

export type StopDue = {
  lineName: string;
  destination: string;
  seconds: number;
  expected: string;
};

async function loadDue(
  naptanId: string,
  lineIds: string[],
  limit: number,
): Promise<{ ok: true; arrivals: StopDue[] } | { ok: false; error: string }> {
  try {
    const response = await fetch(tflUrl(`/StopPoint/${encodeURIComponent(naptanId)}/Arrivals`), {
      signal: AbortSignal.timeout(12_000),
    });
    if (response.status === 404) return { ok: false, error: "TfL doesn't list that stop." };
    if (!response.ok) return { ok: false, error: "Couldn't load times. Try again." };
    const rows = (await response.json()) as {
      lineName?: string;
      lineId?: string;
      destinationName?: string;
      timeToStation?: number;
      expectedArrival?: string;
      vehicleId?: string;
    }[];
    if (!Array.isArray(rows)) return { ok: true, arrivals: [] };
    const wanted = new Set(lineIds);
    const seen = new Set<string>();
    const arrivals: StopDue[] = [];
    const sorted = rows
      .filter((row) => Number.isFinite(Number(row.timeToStation)))
      .sort((a, b) => Number(a.timeToStation) - Number(b.timeToStation));
    for (const row of sorted) {
      const lineId = String(row.lineId ?? row.lineName ?? "").toUpperCase();
      if (wanted.size > 0 && !wanted.has(lineId) && !wanted.has(String(row.lineName ?? "").toUpperCase())) continue;
      const vehicle = String(row.vehicleId ?? `${lineId}-${row.expectedArrival ?? row.timeToStation}`);
      if (seen.has(vehicle)) continue;
      seen.add(vehicle);
      arrivals.push({
        lineName: String(row.lineName ?? lineId),
        destination: decodeText(String(row.destinationName ?? "destination")),
        seconds: Math.max(0, Number(row.timeToStation)),
        expected: String(row.expectedArrival ?? ""),
      });
      if (arrivals.length === limit) break;
    }
    return { ok: true, arrivals };
  } catch {
    return { ok: false, error: "Couldn't load times. Try again." };
  }
}

export const stopArrivals = createServerFn({ method: "POST" })
  .validator((input: unknown): { naptanId: string; lineIds: string[] } => {
    if (!input || typeof input !== "object") throw new Error("Missing stop.");
    const raw = input as { naptanId?: unknown; lineIds?: unknown };
    const naptanId = String(raw.naptanId ?? "").trim();
    if (!/^[A-Za-z0-9]{5,20}$/.test(naptanId)) throw new Error("That stop isn't recognised.");
    const lineIds = Array.isArray(raw.lineIds)
      ? raw.lineIds
          .map((id) => String(id).trim().toUpperCase())
          .filter((id) => LINE_RE.test(id))
          .slice(0, 8)
      : [];
    return { naptanId, lineIds };
  })
  .handler(async ({ data }) => loadDue(data.naptanId, data.lineIds, 3));

export type StopMatch = {
  id: string;
  name: string;
  towards: string;
  letter: string;
};

export const searchStops = createServerFn({ method: "POST" })
  .validator((input: unknown): { query: string } => {
    const query =
      typeof input === "object" && input && "query" in input ? String((input as { query: unknown }).query) : "";
    const cleaned = query.trim().replace(/\s+/g, " ").slice(0, 60);
    if (!/^[\p{L}\p{N} .'\u2019-]+$/u.test(cleaned) || cleaned.length < 2) {
      throw new Error("Type a stop name, like Oxford Circus.");
    }
    return { query: cleaned };
  })
  .handler(async ({ data }): Promise<{ ok: true; stops: StopMatch[] } | { ok: false; error: string }> => {
    try {
      const url = tflUrl(`/StopPoint/Search/${encodeURIComponent(data.query)}`);
      url.searchParams.set("modes", "bus");
      url.searchParams.set("maxResults", "8");
      const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
      if (!response.ok) return { ok: false, error: "Couldn't search stops." };
      const payload = (await response.json()) as { matches?: unknown };
      if (!Array.isArray(payload.matches)) return { ok: true, stops: [] };
      const stops: StopMatch[] = [];
      for (const match of payload.matches) {
        if (!match || typeof match !== "object") continue;
        const row = match as { id?: unknown; name?: unknown; towards?: unknown; stopLetter?: unknown };
        const id = String(row.id ?? "");
        if (!/^[A-Za-z0-9]{5,20}$/.test(id)) continue;
        stops.push({
          id,
          name: decodeText(String(row.name ?? "Stop")),
          towards: decodeText(String(row.towards ?? "")),
          letter: String(row.stopLetter ?? "").slice(0, 3),
        });
      }
      return { ok: true, stops };
    } catch {
      return { ok: false, error: "Couldn't search stops." };
    }
  });

export const favouriteBoard = createServerFn({ method: "POST" })
  .validator((input: unknown): { ids: string[] } => {
    if (!input || typeof input !== "object") throw new Error("Missing stops.");
    const raw = (input as { ids?: unknown }).ids;
    if (!Array.isArray(raw) || raw.length === 0) throw new Error("Save a stop first.");
    const ids = [...new Set(raw.map((id) => String(id).trim()).filter((id) => /^[A-Za-z0-9]{5,20}$/.test(id)))].slice(
      0,
      12,
    );
    if (ids.length === 0) throw new Error("Save a stop first.");
    return { ids };
  })
  .handler(async ({ data }) => {
    const boards = await Promise.all(
      data.ids.map(async (id) => {
        const result = await loadDue(id, [], 3);
        return result.ok
          ? { id, arrivals: result.arrivals }
          : { id, arrivals: [] as StopDue[], error: result.error };
      }),
    );
    return { boards };
  });
