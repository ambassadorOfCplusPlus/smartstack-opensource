// Статус публикации мессенджера наружу. cloudflared запускается ОТДЕЛЬНЫМ
// контейнером (профиль `tunnel` в docker-compose) — изолирован от API, не может
// его «подвесить». Здесь только ЧИТАЕМ публичный адрес с его metrics-эндпоинта
// (/quicktunnel отдаёт {hostname} для быстрого туннеля). Если сервис не поднят —
// running:false.

export interface TunnelStatus {
  running: boolean;
  url: string | null;
}

const METRICS = process.env.TUNNEL_METRICS_URL || 'http://cloudflared:2000';

export async function tunnelStatus(): Promise<TunnelStatus> {
  try {
    const res = await fetch(`${METRICS}/quicktunnel`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { running: false, url: null };
    const j = (await res.json()) as { hostname?: string };
    return j.hostname ? { running: true, url: `https://${j.hostname}` } : { running: false, url: null };
  } catch {
    return { running: false, url: null }; // контейнер туннеля не запущен/недоступен
  }
}
