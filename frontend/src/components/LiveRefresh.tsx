"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export function LiveRefresh() {
  const router = useRouter();
  const [updated, setUpdated] = useState<string | null>(null);
  useEffect(() => {
    let signing = false;
    const transaction = (event: Event) => { signing = Boolean((event as CustomEvent<boolean>).detail); };
    const tick = () => {
      if (document.hidden || signing) return;
      router.refresh();
      setUpdated(new Date().toLocaleTimeString());
    };
    const timer = setInterval(tick, 60000);
    window.addEventListener("sentinel:transaction", transaction);
    return () => { clearInterval(timer); window.removeEventListener("sentinel:transaction", transaction); };
  }, [router]);
  return <p className="live-refresh">● VERİ YENİLEME · 60 sn{updated && ` · son yenileme isteği ${updated}`} · RPC/API hataları kaynak etiketinde gösterilir</p>;
}
