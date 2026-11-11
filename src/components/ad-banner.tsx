import { useEffect, useState } from "react";

const UNIT_RE = /^ca-app-pub-(\d{10,20})\/(\d{6,20})$/;

export function parseAdsUnit(value: string) {
  const match = value.trim().match(UNIT_RE);
  if (!match) return null;
  return { client: `ca-pub-${match[1]}`, slot: match[2] };
}

type AdsWindow = Window & { adsbygoogle?: Record<string, unknown>[] };

export function AdBanner({ unit }: { unit: string }) {
  const parsed = parseAdsUnit(unit);
  const client = parsed?.client ?? "";
  const slot = parsed?.slot ?? "";
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!client || !slot) return;
    let script = document.getElementById("google-mobile-ads") as HTMLScriptElement | null;
    if (!script) {
      script = document.createElement("script");
      script.id = "google-mobile-ads";
      script.async = true;
      script.crossOrigin = "anonymous";
      script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(client)}`;
      script.onerror = () => setFailed(true);
      document.head.appendChild(script);
    }
    const frame = window.setTimeout(() => {
      try {
        const ads = (window as AdsWindow).adsbygoogle ?? [];
        (window as AdsWindow).adsbygoogle = ads;
        ads.push({});
      } catch {
        setFailed(true);
      }
    }, 50);
    return () => window.clearTimeout(frame);
  }, [client, slot]);

  if (!parsed) return null;

  return (
    <aside className="ad-banner" aria-label="Advertisement">
      {failed ? (
        <p className="ad-fallback">Advertisement</p>
      ) : (
        <ins
          className="adsbygoogle"
          style={{ display: "block", width: "100%", height: "50px" }}
          data-ad-client={client}
          data-ad-slot={slot}
        />
      )}
    </aside>
  );
}
