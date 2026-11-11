import { create } from "zustand";
import type { DirectionName, FavouriteStop, Watch } from "@/lib/buses";

const STORAGE_KEY = "fleetline";

type FleetState = {
  watches: Watch[];
  favourites: FavouriteStop[];
  apiKey: string;
  adsUnit: string;
  hydrated: boolean;
  hydrate: () => void;
  addWatch: (watch: Watch) => void;
  removeWatch: (lineId: string, direction: DirectionName) => void;
  addFavourite: (stop: FavouriteStop) => void;
  removeFavourite: (id: string) => void;
  setApiKey: (apiKey: string) => void;
  setAdsUnit: (adsUnit: string) => void;
};

function persist(state: Pick<FleetState, "watches" | "favourites" | "apiKey" | "adsUnit">) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        watches: state.watches,
        favourites: state.favourites,
        apiKey: state.apiKey,
        adsUnit: state.adsUnit,
      }),
    );
  } catch {
    /* a full or blocked store should not stop a stop from being saved */
  }
}

export const useFleet = create<FleetState>((set, get) => ({
  watches: [],
  favourites: [],
  apiKey: "",
  adsUnit: "",
  hydrated: false,
  hydrate: () => {
    if (get().hydrated) return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as {
          watches?: Watch[];
          favourites?: FavouriteStop[];
          apiKey?: string;
          adsUnit?: string;
        };
        set({
          watches: Array.isArray(parsed.watches) ? parsed.watches : [],
          favourites: Array.isArray(parsed.favourites) ? parsed.favourites.filter(isFavourite) : [],
          apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
          adsUnit: typeof parsed.adsUnit === "string" ? parsed.adsUnit : "",
          hydrated: true,
        });
        return;
      }
    } catch {
      /* keep the empty map if storage is unreadable */
    }
    set({ hydrated: true });
  },
  addWatch: (watch) => {
    const watches = [
      watch,
      ...get().watches.filter((item) => item.lineId !== watch.lineId || item.direction !== watch.direction),
    ].slice(0, 8);
    set({ watches });
    persist(get());
  },
  removeWatch: (lineId, direction) => {
    const watches = get().watches.filter((item) => item.lineId !== lineId || item.direction !== direction);
    set({ watches });
    persist(get());
  },
  addFavourite: (stop) => {
    if (!isFavourite(stop)) return;
    const favourites = [stop, ...get().favourites.filter((item) => item.id !== stop.id)].slice(0, 12);
    set({ favourites });
    persist(get());
  },
  removeFavourite: (id) => {
    const favourites = get().favourites.filter((item) => item.id !== id);
    set({ favourites });
    persist(get());
  },
  setApiKey: (apiKey) => {
    set({ apiKey });
    persist(get());
  },
  setAdsUnit: (adsUnit) => {
    set({ adsUnit });
    persist(get());
  },
}));

function isFavourite(stop: FavouriteStop | undefined): stop is FavouriteStop {
  return Boolean(stop && /^[A-Za-z0-9]{5,20}$/.test(stop.id) && stop.name.trim());
}
