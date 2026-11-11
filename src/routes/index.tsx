import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Map as MapIcon, Route as RouteIcon } from "lucide-react";
import { FleetSheet } from "@/components/fleet-sheet";
import { PwaRegister } from "@/components/pwa-register";
import { watchKey, type LineAlert, type LiveResult, type Watch } from "@/lib/buses";
import { liveBuses } from "@/lib/buses.functions";
import { useFleet } from "@/lib/store";
import type { MapRoute } from "@/components/fleet-map";

const FleetMap = lazy(() => import("@/components/fleet-map").then((mod) => ({ default: mod.FleetMap })));

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const watches = useFleet((state) => state.watches);
  const hydrated = useFleet((state) => state.hydrated);
  const hydrate = useFleet((state) => state.hydrate);
  const addWatch = useFleet((state) => state.addWatch);
  const removeWatch = useFleet((state) => state.removeWatch);
  const [tab, setTab] = useState<"map" | "routes">("map");
  const [live, setLive] = useState<LiveResult & { fetchedAt: number }>({
    vehicles: [],
    mode: "estimate",
    alerts: [],
    fetchedAt: 0,
  });
  const [looking, setLooking] = useState(false);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!hydrated) return;
    if (watches.length === 0) {
      setLive({ vehicles: [], mode: "estimate", alerts: [], fetchedAt: Date.now() });
      return;
    }
    let cancelled = false;
    const run = async () => {
      setLooking(true);
      try {
        const result = await liveBuses({
          data: {
            watches: watches.map((watch) => boundsOf(watch)),
          },
        });
        if (!cancelled) setLive({ ...result, fetchedAt: Date.now() });
      } catch (error) {
        if (!cancelled) {
          setLive((prev) => ({
            ...prev,
            keyError: error instanceof Error ? error.message : "Live update failed.",
            fetchedAt: prev.fetchedAt || Date.now(),
          }));
        }
      } finally {
        if (!cancelled) setLooking(false);
      }
    };
    void run();
    const timer = window.setInterval(() => void run(), 12_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [hydrated, watches]);

  const alertByLine = new Map(live.alerts.map((alert) => [alert.lineId, alert]));
  const routes = useMemo<MapRoute[]>(
    () =>
      watches.map((watch) => ({
        key: watchKey(watch),
        segments: watch.segments,
        stops: watch.stops,
        severity: alertByLine.get(watch.lineId)?.severity,
      })),
    [watches, live.alerts],
  );

  const counts: Record<string, number> = {};
  const lateCounts: Record<string, number> = {};
  for (const bus of live.vehicles) {
    const key = `${bus.lineId}:${bus.direction}`;
    counts[key] = (counts[key] ?? 0) + 1;
    if (bus.delayed) lateCounts[key] = (lateCounts[key] ?? 0) + 1;
  }

  const status = statusLine(watches.length, live, looking);
  const banner = bannerText(live.alerts, live.vehicles.filter((bus) => bus.delayed).length);

  return (
    <main className="app-shell bg-bg text-fg">
      <PwaRegister />
      <Suspense fallback={<div className="fleet-map" aria-hidden="true" />}>
        <FleetMap routes={routes} buses={live.vehicles} fetchedAt={live.fetchedAt} />
      </Suspense>
      <header className="map-bar" hidden={tab !== "map"}>
        <div>
          <h1 className="text-xl leading-tight font-semibold tracking-tight text-fg">Lndn Buses Live</h1>
        </div>
        <p className="pointer-events-auto inline-flex min-h-11 items-center gap-2 rounded-full bg-surface-2 px-3 text-sm font-medium text-fg">
          <span className="live-dot" aria-hidden="true" />
          Live
        </p>
      </header>
      {tab === "map" && banner ? (
        <p className={`alert-banner ${banner.severity}`} role="status">
          <strong>{banner.title}</strong>
          <span>{banner.detail}</span>
        </p>
      ) : null}
      <FleetSheet
        open={tab === "routes"}
        watches={watches}
        counts={counts}
        lateCounts={lateCounts}
        alerts={live.alerts}
        status={status}
        onAdd={addWatch}
        onRemove={removeWatch}
      />
      <nav className="tabbar" aria-label="App">
        <button type="button" className="tab" aria-current={tab === "map" ? "page" : undefined} onClick={() => setTab("map")}>
          <MapIcon className="size-5" aria-hidden="true" />
          Map
        </button>
        <button
          type="button"
          className="tab"
          aria-current={tab === "routes" ? "page" : undefined}
          onClick={() => setTab("routes")}
        >
          <RouteIcon className="size-5" aria-hidden="true" />
          Routes
          {watches.length > 0 ? <span className="tab-count">{watches.length}</span> : null}
        </button>
      </nav>
    </main>
  );
}

function boundsOf(watch: Watch) {
  let minLat = 90;
  let minLon = 180;
  let maxLat = -90;
  let maxLon = -180;
  for (const stop of watch.stops) {
    minLat = Math.min(minLat, stop.lat);
    maxLat = Math.max(maxLat, stop.lat);
    minLon = Math.min(minLon, stop.lon);
    maxLon = Math.max(maxLon, stop.lon);
  }
  if (!Number.isFinite(minLat) || minLat > maxLat) {
    minLat = 51.48;
    maxLat = 51.53;
    minLon = -0.16;
    maxLon = -0.08;
  }
  return {
    lineId: watch.lineId,
    lineName: watch.lineName,
    direction: watch.direction,
    destinationName: watch.destinationName,
    stopIds: watch.stops.map((stop) => stop.id),
    minLat,
    minLon,
    maxLat,
    maxLon,
  };
}

function bannerText(alerts: LineAlert[], lateBuses: number) {
  const major = alerts.find((alert) => alert.severity === "major");
  if (major) return { severity: "major" as const, title: `${major.lineId} · ${major.title}`, detail: major.detail };
  const minor = alerts[0];
  if (minor) return { severity: "minor" as const, title: `${minor.lineId} · ${minor.title}`, detail: minor.detail };
  if (lateBuses > 0) {
    return {
      severity: "major" as const,
      title: lateBuses === 1 ? "Major delay" : `${lateBuses} major delays`,
      detail: "A followed bus is more than 15 minutes away.",
    };
  }
  return null;
}

function statusLine(routeCount: number, live: LiveResult, looking: boolean) {
  if (routeCount === 0) return "Add a route, pick a direction, watch it move.";
  if (looking && live.vehicles.length === 0) return "Finding buses on the route…";
  if (live.keyError) return live.keyError;
  if (live.note) return live.note;
  if (live.vehicles.length === 0) return "No buses on this direction right now.";
  const count = `${live.vehicles.length} ${live.vehicles.length === 1 ? "bus" : "buses"}`;
  return `${count} gliding from live countdown`;
}
