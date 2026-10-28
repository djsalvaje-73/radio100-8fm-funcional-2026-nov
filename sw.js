// ===== CONFIG: tu stream original (http, con puerto raro) =====
const STREAM_URL = "http://uk18freenew.listen2myradio.com:38247/stream";

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store"
    }
  });
}

// Parser ICY binario CORRECTO: respeta Icy-MetaInt en vez de hacer regex a ciegas.
async function readIcyTitle(streamUrl, debug) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 6000);
  const info = { icyMetaInt: 0, icyName: null, icyGenre: null, bytesRead: 0, foundTitle: false, title: null, rawSample: "" };
  try {
    const up = await fetch(streamUrl, {
      signal: ac.signal,
      headers: { "Icy-MetaData": "1", "User-Agent": "LaJoyaNP/1.0" }
    });
    info.icyMetaInt = parseInt(up.headers.get("Icy-MetaInt") || "0", 10);
    info.icyName  = up.headers.get("Icy-Name")  || up.headers.get("Ice-Name")  || null;
    info.icyGenre = up.headers.get("Icy-Genre") || up.headers.get("Ice-Genre") || null;

    if (!info.icyMetaInt || info.icyMetaInt <= 0) {
      // El servidor NO intercala metadatos -> no hay StreamTitle que leer.
      info.reason = "no-icy-metaint";
      return { ok: false, info };
    }

    const reader = up.body.getReader();
    let buf = new Uint8Array(0);          // buffer acumulador
    const MAX_BYTES = 512 * 1024;         // tope de lectura (no saturar el slot)
    const dec = new TextDecoder("latin1");

    const ensure = (n) => {               // asegura al menos n bytes en buf, devuelve true si logró
      while (buf.length < n) {
        if (info.bytesRead >= MAX_BYTES) return false;
        const { done, value } = reader.read ? { done: true } : {}; // placeholder (se rellena abajo)
        return false; // nunca se usa: el bucle principal llama a read() explícito
      }
      return true;
    };

    // Bucle principal de desentrelazado audio/metadatos
    let done = false;
    while (!done && info.bytesRead < MAX_BYTES) {
      const chunk = await reader.read();
      if (chunk.done) { done = true; break; }
      // concat
      const nb = new Uint8Array(buf.length + chunk.value.length);
      nb.set(buf, 0); nb.set(chunk.value, buf.length); buf = nb;
      info.bytesRead += chunk.value.length;

      // Mientras tengamos un ciclo completo [MetaInt audio][1 len][len*16 meta]
      while (buf.length >= info.icyMetaInt + 1) {
        buf = buf.subarray(info.icyMetaInt);          // descartar bloque de audio
        const metaLenBytes = buf[0] * 16;             // byte de longitud * 16
        buf = buf.subarray(1);
        if (metaLenBytes === 0) continue;             // sin metadatos este ciclo
        if (buf.length < metaLenBytes) break;         // esperamos más datos
        const metaStr = dec.decode(buf.subarray(0, metaLenBytes));
        buf = buf.subarray(metaLenBytes);
        if (!info.rawSample) info.rawSample = metaStr.slice(0, 200);
        const m = metaStr.match(/StreamTitle='([^']*)'/);
        if (m && m[1].trim()) {
          info.title = m[1].trim();
          info.foundTitle = true;
          try { reader.cancel(); } catch (_) {}
          clearTimeout(timer);
          return { ok: true, info };
        }
      }
    }
    try { reader.cancel(); } catch (_) {}
    info.reason = info.reason || "eof-no-title";
    return { ok: false, info };
  } catch (e) {
    info.reason = "exception";
    info.error = String(e && e.message || e);
    return { ok: false, info };
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // ---- Ahora suena ----
    if (url.pathname === "/nowplaying") {
      const res = await readIcyTitle(STREAM_URL, url.searchParams.get("debug"));
      if (url.searchParams.get("debug") === "1") return json(res, res.ok ? 200 : 200); // siempre 200 para ver el diagnóstico
      return json({
        ok: res.ok,
        title: res.info.title || null,
        station: res.info.icyName || null,
        genre: res.info.icyGenre || null,
        reason: res.info.reason || null
      });
    }

    // ---- Stream de audio (passthrough SIN metadatos intercalados, para que el <audio> reproduzca limpio) ----
    const upstream = await fetch(STREAM_URL, {
      headers: { "Icy-MetaData": "0", "User-Agent": "LaJoyaPlayer/1.0" }
    });
    const headers = new Headers();
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Content-Type", upstream.headers.get("Content-Type") || "audio/mpeg");
    headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
    return new Response(upstream.body, { status: upstream.status, headers });
  }
};