export type LatLng = [number, number];

const EARTH = 6_371_000;

export function metersBetween(aLat: number, aLng: number, bLat: number, bLng: number) {
  const lat0 = ((aLat + bLat) / 2) * (Math.PI / 180);
  const x = (bLng - aLng) * (Math.PI / 180) * Math.cos(lat0) * EARTH;
  const y = (bLat - aLat) * (Math.PI / 180) * EARTH;
  return Math.hypot(x, y);
}

export type Track = {
  points: LatLng[];
  cum: number[];
  total: number;
};

export function buildTrack(points: LatLng[]): Track {
  const clean = points.filter((p, i) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1]);
  const cum = [0];
  for (let i = 1; i < clean.length; i++) {
    cum.push(cum[i - 1] + metersBetween(clean[i - 1][0], clean[i - 1][1], clean[i][0], clean[i][1]));
  }
  return { points: clean, cum, total: cum[cum.length - 1] ?? 0 };
}

export function stitchSegments(segments: LatLng[][]): LatLng[] {
  const ordered = [...segments].filter((s) => s.length > 1).sort((a, b) => b.length - a.length);
  if (ordered.length === 0) return [];
  const used = new Set<number>();
  const out = [...ordered[0]];
  used.add(0);
  let grew = true;
  while (grew) {
    grew = false;
    const head = out[0];
    const tail = out[out.length - 1];
    let best = -1;
    let mode: "tail" | "head" | "tail-rev" | "head-rev" = "tail";
    let bestGap = 160;
    for (let i = 0; i < ordered.length; i++) {
      if (used.has(i)) continue;
      const seg = ordered[i];
      const a = seg[0];
      const b = seg[seg.length - 1];
      const options: [number, "tail" | "head" | "tail-rev" | "head-rev"][] = [
        [metersBetween(tail[0], tail[1], a[0], a[1]), "tail"],
        [metersBetween(tail[0], tail[1], b[0], b[1]), "tail-rev"],
        [metersBetween(head[0], head[1], b[0], b[1]), "head"],
        [metersBetween(head[0], head[1], a[0], a[1]), "head-rev"],
      ];
      for (const [gap, how] of options) {
        if (gap < bestGap) {
          bestGap = gap;
          best = i;
          mode = how;
        }
      }
    }
    if (best >= 0) {
      used.add(best);
      const seg = ordered[best];
      const forward = mode.endsWith("rev") ? [...seg].reverse() : seg;
      if (mode.startsWith("tail")) out.push(...forward.slice(1));
      else out.unshift(...forward.slice(0, -1));
      grew = true;
    }
  }
  return out;
}

function toLocal(origin: LatLng, p: LatLng) {
  const lat0 = origin[0] * (Math.PI / 180);
  return {
    x: (p[1] - origin[1]) * (Math.PI / 180) * Math.cos(lat0) * EARTH,
    y: (p[0] - origin[0]) * (Math.PI / 180) * EARTH,
  };
}

export function pointAt(track: Track, distance: number): { lat: number; lng: number; bearing: number } {
  const pts = track.points;
  if (pts.length === 0) return { lat: 51.5074, lng: -0.1278, bearing: 0 };
  if (pts.length === 1 || distance <= 0) {
    const next = pts[Math.min(1, pts.length - 1)];
    return { lat: pts[0][0], lng: pts[0][1], bearing: bearingBetween(pts[0], next) };
  }
  if (distance >= track.total) {
    const n = pts.length - 1;
    return { lat: pts[n][0], lng: pts[n][1], bearing: bearingBetween(pts[Math.max(0, n - 1)], pts[n]) };
  }
  let lo = 1;
  let hi = track.cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (track.cum[mid] < distance) lo = mid + 1;
    else hi = mid;
  }
  const d0 = track.cum[lo - 1];
  const d1 = track.cum[lo];
  const t = d1 === d0 ? 0 : (distance - d0) / (d1 - d0);
  const a = pts[lo - 1];
  const b = pts[lo];
  return {
    lat: a[0] + (b[0] - a[0]) * t,
    lng: a[1] + (b[1] - a[1]) * t,
    bearing: bearingBetween(a, b),
  };
}

export function nearestAlong(track: Track, lat: number, lng: number): { along: number; metersOff: number } {
  let bestAlong = 0;
  let bestOff = Infinity;
  const step = track.points.length > 2400 ? 2 : 1;
  for (let i = step; i < track.points.length; i += step) {
    const a = track.points[i - step];
    const b = track.points[i];
    const ab = toLocal(a, b);
    const ap = toLocal(a, [lat, lng]);
    const len2 = ab.x * ab.x + ab.y * ab.y;
    let t = len2 === 0 ? 0 : (ap.x * ab.x + ap.y * ab.y) / len2;
    t = Math.max(0, Math.min(1, t));
    const plat = a[0] + (b[0] - a[0]) * t;
    const plng = a[1] + (b[1] - a[1]) * t;
    const off = metersBetween(lat, lng, plat, plng);
    if (off < bestOff) {
      bestOff = off;
      bestAlong = track.cum[i - step] + metersBetween(a[0], a[1], plat, plng);
    }
  }
  return { along: bestAlong, metersOff: bestOff };
}

export function bearingBetween(a: LatLng, b: LatLng) {
  const lat1 = a[0] * (Math.PI / 180);
  const lat2 = b[0] * (Math.PI / 180);
  const dLng = (b[1] - a[1]) * (Math.PI / 180);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

export function drift(lat: number, lng: number, bearingDeg: number, meters: number): LatLng {
  const rad = (bearingDeg * Math.PI) / 180;
  const dLat = (meters * Math.cos(rad)) / 111_320;
  const dLng = (meters * Math.sin(rad)) / (111_320 * Math.cos((lat * Math.PI) / 180));
  return [lat + dLat, lng + dLng];
}
