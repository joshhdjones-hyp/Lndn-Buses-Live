import { useState } from "react";
import { X } from "lucide-react";
import { lookupRoute } from "@/lib/buses.functions";
import { POPULAR, watchKey, type DirectionRoute, type Watch } from "@/lib/buses";

const LINE_RE = /^[A-Za-z]{0,3}\d{1,4}[A-Za-z]?$/;

export function FleetSheet({
  open,
  watches,
  counts,
  status,
  onAdd,
  onRemove,
}: {
  open: boolean;
  watches: Watch[];
  counts: Record<string, number>;
  status: string;
  onAdd: (watch: Watch) => void;
  onRemove: (lineId: string, direction: Watch["direction"]) => void;
}) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [choice, setChoice] = useState<{ lineId: string; lineName: string; directions: DirectionRoute[] } | null>(
    null,
  );

  async function lookup(raw: string) {
    const lineId = raw.trim().toUpperCase().replace(/\s+/g, "");
    if (!LINE_RE.test(lineId)) {
      setError("Use a route number like 25, N8 or SL1.");
      setChoice(null);
      return;
    }
    setBusy(true);
    setError("");
    setChoice(null);
    try {
      const result = await lookupRoute({ data: { lineId } });
      if (!result.ok) setError(result.error);
      else setChoice({ lineId: result.lineId, lineName: result.lineName, directions: result.directions });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't look that up.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="routes-screen" hidden={!open}>
      <div className="routes-body">
        <h2 className="text-2xl font-semibold tracking-tight text-fg">Routes</h2>
        <p className="mt-1 text-sm text-muted">{status}</p>

        {watches.length > 0 ? (
          <ul className="mt-4 grid gap-2">
            {watches.map((watch) => {
              const count = counts[watchKey(watch)] ?? 0;
              return (
                <li key={watchKey(watch)} className="flex items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-3">
                  <span className="grid size-11 shrink-0 place-items-center rounded-full bg-primary text-sm font-semibold text-primary-fg">
                    {watch.lineName}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-fg">Towards {watch.destinationName}</span>
                    <span className="block text-sm text-muted">
                      {count} {count === 1 ? "bus" : "buses"} on the map
                    </span>
                  </span>
                  <button
                    type="button"
                    className="grid size-11 shrink-0 place-items-center rounded-full border border-border text-fg"
                    aria-label={`Stop following route ${watch.lineName} towards ${watch.destinationName}`}
                    onClick={() => onRemove(watch.lineId, watch.direction)}
                  >
                    <X className="size-4" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-4 text-sm text-muted">Nothing followed yet. Add a route below.</p>
        )}

        <form
          className="mt-5 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void lookup(query);
          }}
        >
          <label className="sr-only" htmlFor="route-number">
            Route number
          </label>
          <input
            id="route-number"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            inputMode="text"
            placeholder="Route, like 25"
            className="min-h-11 min-w-0 flex-1 rounded-full border border-border bg-surface px-4 text-base text-fg outline-none focus:border-primary"
          />
          <button
            type="submit"
            disabled={busy}
            className="min-h-11 rounded-full bg-primary px-5 text-sm font-semibold text-primary-fg disabled:opacity-60"
          >
            {busy ? "Looking" : "Add"}
          </button>
        </form>

        {choice ? (
          <div className="mt-4 grid gap-2">
            <p className="text-sm text-muted">Which way is route {choice.lineName} going?</p>
            {choice.directions.map((direction) => {
              const following = watches.some(
                (watch) => watch.lineId === choice.lineId && watch.direction === direction.direction,
              );
              return (
                <button
                  key={direction.direction}
                  type="button"
                  disabled={following}
                  className="flex min-h-11 items-center justify-between gap-3 rounded-2xl border border-border bg-surface px-4 py-3 text-left disabled:opacity-50"
                  onClick={() => {
                    onAdd({
                      lineId: choice.lineId,
                      lineName: choice.lineName,
                      ...direction,
                    });
                    setChoice(null);
                    setQuery("");
                  }}
                >
                  <span>
                    <span className="block text-sm font-semibold text-fg">Towards {direction.destinationName}</span>
                    <span className="block text-sm text-muted">From {direction.originName}</span>
                  </span>
                  <span className="text-sm text-muted">{following ? "On map" : `${direction.stops.length} stops`}</span>
                </button>
              );
            })}
          </div>
        ) : null}

        {error ? <p className="mt-3 text-sm text-primary">{error}</p> : null}

        {!choice ? (
          <div className="mt-4 grid grid-cols-3 gap-2">
            {POPULAR.map((line) => (
              <button
                key={line}
                type="button"
                className="min-h-14 rounded-2xl border border-border bg-surface text-base font-semibold text-fg"
                onClick={() => {
                  setQuery(line);
                  void lookup(line);
                }}
              >
                {line}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
