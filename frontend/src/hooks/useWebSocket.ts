import { useEffect, useRef, useState, useCallback } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type WSStatus = "connecting" | "connected" | "disconnected" | "error";

export interface WSEvent {
  type: string;
  payload: unknown;
}

type EventHandler = (payload: unknown) => void;

interface UseWebSocketOptions {
  /** JWT token — connection won't start until this is non-null */
  token: string | null;
  /** WebSocket base URL (without /ws path), defaults to current origin */
  url?: string;
  /** Initial max reconnect backoff in ms (doubles each attempt, capped at maxBackoff) */
  initialBackoff?: number;
  maxBackoff?: number;
}

interface UseWebSocketReturn {
  status: WSStatus;
  connected: boolean;
  lastEvent: WSEvent | null;
  /** Subscribe to a specific event type. Returns an unsubscribe function. */
  subscribe: (type: string, handler: EventHandler) => () => void;
  /** Send a raw payload over the socket */
  send: (data: unknown) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

const WS_BASE =
  (import.meta as any).env?.VITE_WS_URL ??
  (typeof window !== "undefined"
    ? window.location.origin.replace(/^http/, "ws")
    : "ws://localhost:3001");

export function useWebSocket({
  token,
  url = WS_BASE,
  initialBackoff = 1000,
  maxBackoff = 30_000,
}: UseWebSocketOptions): UseWebSocketReturn {
  const [status, setStatus] = useState<WSStatus>("disconnected");
  const [lastEvent, setLastEvent] = useState<WSEvent | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef(initialBackoff);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  // Map of event type -> set of handlers
  const handlersRef = useRef<Map<string, Set<EventHandler>>>(new Map());

  const clearReconnectTimer = () => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  };

  const connect = useCallback(() => {
    if (!mountedRef.current || !token) return;

    clearReconnectTimer();

    const wsUrl = `${url}/ws?token=${encodeURIComponent(token)}`;
    setStatus("connecting");

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      setStatus("error");
      scheduleReconnect();
      return;
    }

    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      setStatus("connected");
      backoffRef.current = initialBackoff; // reset backoff on successful connect
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setStatus("disconnected");
      scheduleReconnect();
    };

    ws.onerror = () => {
      ws.close();
    };

    ws.onmessage = (ev) => {
      if (!mountedRef.current) return;
      try {
        const event = JSON.parse(ev.data as string) as WSEvent;
        setLastEvent(event);

        // Dispatch to type-specific subscribers
        const handlers = handlersRef.current.get(event.type);
        if (handlers) {
          handlers.forEach((h) => h(event.payload));
        }
        // Wildcard subscribers
        const wildcards = handlersRef.current.get("*");
        if (wildcards) {
          wildcards.forEach((h) => h(event));
        }
      } catch {
        // non-JSON frame — ignore
      }
    };
  }, [token, url, initialBackoff]);

  const scheduleReconnect = useCallback(() => {
    if (!mountedRef.current || !token) return;
    const delay = backoffRef.current;
    backoffRef.current = Math.min(backoffRef.current * 2, maxBackoff);
    reconnectTimerRef.current = setTimeout(() => {
      connect();
    }, delay);
  }, [connect, maxBackoff, token]);

  useEffect(() => {
    mountedRef.current = true;
    if (token) {
      connect();
    } else {
      setStatus("disconnected");
    }

    return () => {
      mountedRef.current = false;
      clearReconnectTimer();
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent reconnect on intentional close
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [token, connect]);

  const subscribe = useCallback(
    (type: string, handler: EventHandler): (() => void) => {
      if (!handlersRef.current.has(type)) {
        handlersRef.current.set(type, new Set());
      }
      handlersRef.current.get(type)!.add(handler);

      return () => {
        handlersRef.current.get(type)?.delete(handler);
      };
    },
    []
  );

  const send = useCallback((data: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  return {
    status,
    connected: status === "connected",
    lastEvent,
    subscribe,
    send,
  };
}
