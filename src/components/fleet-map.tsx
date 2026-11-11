import { useEffect, useMemo, useRef } from "react";
import "leaflet/dist/leaflet.css";
import type { LiveVehicle, Stop } from "@/lib/buses";
import { escapeHtml } from "@/lib/buses";
import { stopArrivals, type StopDue } from "@/lib/buses.functions";
import {
  bearingBetween,
  buildTrack,
  drift,
  metersBetween,
  nearestAlong,
  pointAt,
  stitchSegments,
  type LatLng,
  type Track,
} from "@/lib/geo";
import { previewPathPrefix } from "@/lib/preview-path-prefix";

const CRUISE = 4.2;

export type MapRoute = {
  key: string;
  segments: LatLng[][];
  stops: Stop[];
  severity?: "minor" | "major";
};

type Pack = { track: Track; stops: Map<string, number> };

type Ghost = { lat: number; lng: number; along: number | null; bearing: number; speed: number };

const MAX_ACCEL = 1.05;

function turnTowards(from: number, to: number, dt: number) {
  const delta = ((to - from + 540) % 360) - 180;
  return from + delta * (1 - Math.exp(-dt / 0.75));
}

function stepSpeed(current: number, target: number, dt: number) {
  const maxStep = MAX_ACCEL * dt;
  const delta = target - current;
  if (delta > maxStep) return current + maxStep;
  if (delta < -maxStep) return current - maxStep;
  return target;
}

function targetSpeed(error: number) {
  if (Math.abs(error) < 18) return CRUISE;
  const catchup = error / 8;
  const limit = Math.abs(error) > 700 ? 11 : 6.5;
  return Math.max(-limit, Math.min(limit, CRUISE + catchup));
}

function desired(
  bus: LiveVehicle,
  pack: Pack | undefined,
  fetchedAt: number,
  now: number,
): { lat: number; lng: number; along: number | null; bearing: number } {
  const elapsed = Math.max(0, (now - fetchedAt) / 1000);
  if (bus.source === "estimate" && pack && bus.naptanId && pack.stops.has(bus.naptanId)) {
    const secondsLeft = Math.max(0, (bus.seconds ?? 0) - elapsed);
    const along = Math.max(0, (pack.stops.get(bus.naptanId) ?? 0) - secondsLeft * CRUISE);
    const point = pointAt(pack.track, along);
    return { lat: point.lat, lng: point.lng, along, bearing: point.bearing };
  }
  if (bus.lat != null && bus.lon != null && pack && pack.track.total > 0) {
    const projected = nearestAlong(pack.track, bus.lat, bus.lon);
    if (projected.metersOff < 450) {
      const along = Math.min(pack.track.total, projected.along + Math.min(220, elapsed * CRUISE));
      const point = pointAt(pack.track, along);
      return { lat: point.lat, lng: point.lng, along, bearing: point.bearing || bus.bearing };
    }
  }
  if (bus.lat != null && bus.lon != null) {
    const moved = drift(bus.lat, bus.lon, bus.bearing, Math.min(180, elapsed * CRUISE));
    return { lat: moved[0], lng: moved[1], along: null, bearing: bus.bearing };
  }
  return { lat: 51.5074, lng: -0.1278, along: null, bearing: 0 };
}

function popupHtml(bus: LiveVehicle) {
  const kind = bus.delayed
    ? "Major delay · more than 15 min"
    : bus.source === "gps"
      ? "Live GPS"
      : "Countdown, moving along the route";
  return `<strong>${escapeHtml(bus.lineName)} to ${escapeHtml(bus.destination)}</strong><span>${kind}</span>`;
}

type LeafletNs = typeof import("leaflet");

function busMarker(L: LeafletNs, bus: LiveVehicle) {
  const icon = L.divIcon({
    className: "bus-pin",
    html: `<span class="bus-badge${bus.delayed ? " is-late" : ""}"><span class="bus-head"></span><em>${escapeHtml(bus.lineName)}</em></span>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
  });
  return L.marker([51.5, -0.1], { icon, keyboard: true, alt: `Bus ${bus.lineName}`, zIndexOffset: 400 }).bindPopup(
    popupHtml(bus),
    { className: "bus-pop", closeButton: false },
  );
}

function dueLabel(seconds: number) {
  if (seconds < 30) return "Due";
  const mins = Math.max(1, Math.round(seconds / 60));
  return mins === 1 ? "1 min" : `${mins} min`;
}

function clockLabel(seconds: number, expected: string) {
  const date = expected ? new Date(expected) : new Date(Date.now() + seconds * 1000);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function stopPopup(name: string, arrivals: StopDue[]) {
  if (arrivals.length === 0) {
    return `<strong>${escapeHtml(name)}</strong><span>No followed buses due here.</span>`;
  }
  const rows = arrivals
    .map((bus) => {
      const when = clockLabel(bus.seconds, bus.expected);
      return `<span class="${bus.seconds >= 15 * 60 ? "is-late" : ""}"><em>${escapeHtml(bus.lineName)}</em> to ${escapeHtml(bus.destination)} · ${dueLabel(bus.seconds)}${when ? ` · ${when}` : ""}${bus.seconds >= 15 * 60 ? " · major delay" : ""}</span>`;
    })
    .join("");
  return `<strong>${escapeHtml(name)}</strong>${rows}`;
}

function stopIcon(L: LeafletNs) {
  return L.divIcon({
    className: "stop-pin",
    html: `<span class="stop-dot"></span>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
  });
}

function tileUrl() {
  const prefix = previewPathPrefix(window.location.hostname, window.location.pathname) ?? "";
  return `${prefix}/api/tiles/{z}/{x}/{y}?src=osm`;
}

export function FleetMap({
  routes,
  buses,
  fetchedAt,
}: {
  routes: MapRoute[];
  buses: LiveVehicle[];
  fetchedAt: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const routesRef = useRef(routes);
  const busesRef = useRef(buses);
  const fetchedRef = useRef(fetchedAt);
  const packsRef = useRef<Map<string, Pack>>(new Map());
  routesRef.current = routes;
  busesRef.current = buses;
  fetchedRef.current = fetchedAt;

  const packs = useMemo(() => {
    const next = new Map<string, Pack>();
    for (const route of routes) {
      const stitched = stitchSegments(route.segments);
      const points = stitched.length > 1 ? stitched : route.stops.map((stop) => [stop.lat, stop.lon] as LatLng);
      const track = buildTrack(points);
      const stops = new Map<string, number>();
      for (const stop of route.stops) {
        if (track.total <= 0) break;
        stops.set(stop.id, nearestAlong(track, stop.lat, stop.lon).along);
      }
      next.set(route.key, { track, stops });
    }
    return next;
  }, [routes]);
  packsRef.current = packs;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let frame = 0;
    let removeMap = () => {};

    void import("leaflet").then((L) => {
      if (cancelled || !host.isConnected) return;
      const map = L.map(host, { zoomControl: true, attributionControl: true });
      map.setView([51.5074, -0.12], 12);
      map.attributionControl.setPrefix("");
      L.tileLayer(tileUrl(), {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(map);

      const lines = new Map<string, L.Polyline>();
      const markers = new Map<string, L.Marker>();
      const stopMarkers = new Map<string, L.Marker>();
      const ghosts = new Map<string, Ghost>();
      let lineSig = "";
      let fitSig = "";
      let last = performance.now();
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      const tick = (now: number) => {
        if (cancelled) return;
        const dt = Math.min(0.04, (now - last) / 1000);
        last = now;
        const currentRoutes = routesRef.current;
        const sig = currentRoutes.map((route) => `${route.key}:${route.severity ?? "ok"}`).join("|");
        if (sig !== lineSig) {
          lineSig = sig;
          const keep = new Set(currentRoutes.map((route) => route.key));
          for (const [id, line] of lines) {
            if (!keep.has(id)) {
              line.remove();
              lines.delete(id);
            }
          }
          for (const route of currentRoutes) {
            if (lines.has(route.key) || route.segments.length === 0) continue;
            lines.set(
              route.key,
              L.polyline(route.segments, {
                color: route.severity === "major" ? "#ff7a1a" : route.severity === "minor" ? "#e8a317" : "#e10600",
                weight: route.severity ? 6 : 4,
                opacity: 0.92,
                lineCap: "round",
                lineJoin: "round",
              }).addTo(map),
            );
          }
          const nextStops = new Map<string, { name: string; lat: number; lon: number; lineIds: string[] }>();
          for (const route of currentRoutes) {
            const lineId = route.key.slice(0, route.key.lastIndexOf(":"));
            for (const stop of route.stops) {
              const existing = nextStops.get(stop.id);
              if (existing) {
                if (!existing.lineIds.includes(lineId)) existing.lineIds.push(lineId);
              } else {
                nextStops.set(stop.id, { name: stop.name, lat: stop.lat, lon: stop.lon, lineIds: [lineId] });
              }
            }
          }
          for (const [id, pin] of stopMarkers) {
            if (nextStops.has(id)) continue;
            pin.remove();
            stopMarkers.delete(id);
          }
          for (const [id, stop] of nextStops) {
            if (stopMarkers.has(id)) continue;
            const pin = L.marker([stop.lat, stop.lon], {
              icon: stopIcon(L),
              keyboard: true,
              alt: `Stop ${stop.name}`,
              zIndexOffset: 150,
            }).bindPopup(`<strong>${escapeHtml(stop.name)}</strong><span>Checking the next bus…</span>`, {
              className: "bus-pop",
              closeButton: false,
              offset: [0, -8],
            });
            pin.on("click", () => {
              pin.setPopupContent(`<strong>${escapeHtml(stop.name)}</strong><span>Checking the next bus…</span>`);
              void stopArrivals({ data: { naptanId: id, lineIds: stop.lineIds } })
                .then((result) => {
                  pin.setPopupContent(
                    result.ok
                      ? stopPopup(stop.name, result.arrivals)
                      : `<strong>${escapeHtml(stop.name)}</strong><span>${escapeHtml(result.error)}</span>`,
                  );
                })
                .catch(() => {
                  pin.setPopupContent(`<strong>${escapeHtml(stop.name)}</strong><span>Couldn't load times.</span>`);
                });
            });
            pin.addTo(map);
            stopMarkers.set(id, pin);
          }
        }
        if (sig !== fitSig) {
          fitSig = sig;
          if (currentRoutes.length === 0) map.setView([51.5074, -0.12], 12);
          else {
            const bounds = currentRoutes.flatMap((route) => route.segments.flat());
            if (bounds.length > 1) {
              try {
                map.fitBounds(bounds, {
                  paddingTopLeft: [24, 108],
                  paddingBottomRight: [24, 108],
                  maxZoom: 15,
                  animate: !reduce,
                });
              } catch {
                map.setView(bounds[0], 13);
              }
            }
          }
        }

        const seen = new Set<string>();
        for (const bus of busesRef.current) {
          seen.add(bus.id);
          const pack = packsRef.current.get(`${bus.lineId}:${bus.direction}`);
          const want = desired(bus, pack, fetchedRef.current, Date.now());
          let ghost = ghosts.get(bus.id);
          if (!ghost || reduce) {
            ghost = { lat: want.lat, lng: want.lng, along: want.along, bearing: want.bearing, speed: CRUISE };
            ghosts.set(bus.id, ghost);
          } else if (want.along != null && pack && pack.track.total > 0) {
            if (ghost.along == null) ghost.along = want.along;
            const error = want.along - ghost.along;
            ghost.speed = stepSpeed(ghost.speed, targetSpeed(error), dt);
            ghost.along = Math.max(0, Math.min(pack.track.total, ghost.along + ghost.speed * dt));
            const point = pointAt(pack.track, ghost.along);
            ghost.lat = point.lat;
            ghost.lng = point.lng;
            if (Math.abs(ghost.speed) > 0.4) {
              const look = ghost.speed < 0 ? -32 : 32;
              const ahead = pointAt(pack.track, Math.max(0, Math.min(pack.track.total, ghost.along + look)));
              ghost.bearing = turnTowards(ghost.bearing, ahead.bearing, dt);
            }
          } else {
            const gap = metersBetween(ghost.lat, ghost.lng, want.lat, want.lng);
            if (gap > 1.5) {
              const aim = bearingBetween([ghost.lat, ghost.lng], [want.lat, want.lng]);
              ghost.speed = stepSpeed(ghost.speed, Math.min(8, Math.max(0.8, gap / 7)), dt);
              ghost.bearing = turnTowards(ghost.bearing, aim, dt);
              const moved = drift(ghost.lat, ghost.lng, ghost.bearing, ghost.speed * dt);
              if (metersBetween(moved[0], moved[1], want.lat, want.lng) > gap) {
                ghost.lat = want.lat;
                ghost.lng = want.lng;
                ghost.speed = 0;
              } else {
                ghost.lat = moved[0];
                ghost.lng = moved[1];
              }
            }
            ghost.along = want.along;
          }
          let pin = markers.get(bus.id);
          if (!pin) {
            pin = busMarker(L, bus).addTo(map);
            markers.set(bus.id, pin);
          }
          pin.setLatLng([ghost.lat, ghost.lng]);
          const badge = pin.getElement()?.querySelector<HTMLElement>(".bus-badge");
          if (badge) badge.classList.toggle("is-late", Boolean(bus.delayed));
          const head = pin.getElement()?.querySelector<HTMLElement>(".bus-head");
          if (head) head.style.transform = `rotate(${ghost.bearing}deg)`;
          if (pin.isPopupOpen()) pin.setPopupContent(popupHtml(bus));
        }
        for (const [id, pin] of markers) {
          if (seen.has(id)) continue;
          pin.remove();
          markers.delete(id);
          ghosts.delete(id);
        }
        frame = requestAnimationFrame(tick);
      };

      frame = requestAnimationFrame(tick);
      const onResize = () => map.invalidateSize();
      window.addEventListener("resize", onResize);
      const observer = new ResizeObserver(() => map.invalidateSize());
      observer.observe(host);
      const sized = window.setTimeout(() => map.invalidateSize(), 200);
      removeMap = () => {
        cancelAnimationFrame(frame);
        window.clearTimeout(sized);
        window.removeEventListener("resize", onResize);
        observer.disconnect();
        map.remove();
      };
    });

    return () => {
      cancelled = true;
      removeMap();
    };
  }, []);

  return <div ref={hostRef} className="fleet-map" aria-label="London bus map" />;
}
