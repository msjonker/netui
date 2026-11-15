import type { ComponentChildren } from 'preact';

// Inline 20px line icons (1.5 stroke, rounded joins).
// Inline SVG keeps them themable with currentColor and costs no requests.

function Svg({ children, size = 20, class: cls }: { children: ComponentChildren; size?: number; class?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      class={cls}
    >
      {children}
    </svg>
  );
}

type P = { size?: number; class?: string };

export const IconDashboard = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="3" width="6" height="8" rx="1.5" />
    <rect x="11" y="3" width="6" height="5" rx="1.5" />
    <rect x="11" y="10" width="6" height="7" rx="1.5" />
    <rect x="3" y="13" width="6" height="4" rx="1.5" />
  </Svg>
);

export const IconClients = (p: P) => (
  <Svg {...p}>
    <rect x="2.5" y="4" width="11" height="8" rx="1.5" />
    <path d="M6 15h4M8 12v3" />
    <rect x="14.5" y="7" width="3.5" height="9" rx="1" />
  </Svg>
);

export const IconSettings = (p: P) => (
  <Svg {...p}>
    <circle cx="10" cy="10" r="2.5" />
    <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />
  </Svg>
);

export const IconWifi = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 7.5a11 11 0 0 1 15 0M5 10.5a7.2 7.2 0 0 1 10 0M7.5 13.3a3.6 3.6 0 0 1 5 0" />
    <circle cx="10" cy="16" r="0.6" fill="currentColor" />
  </Svg>
);

export const IconNetwork = (p: P) => (
  <Svg {...p}>
    <rect x="7.5" y="2.5" width="5" height="4" rx="1" />
    <rect x="2.5" y="13.5" width="5" height="4" rx="1" />
    <rect x="12.5" y="13.5" width="5" height="4" rx="1" />
    <path d="M10 6.5V10M5 13.5V10h10v3.5" />
  </Svg>
);

export const IconGlobe = (p: P) => (
  <Svg {...p}>
    <circle cx="10" cy="10" r="7.5" />
    <path d="M2.5 10h15M10 2.5c2 2.2 3 4.7 3 7.5s-1 5.3-3 7.5c-2-2.2-3-4.7-3-7.5s1-5.3 3-7.5Z" />
  </Svg>
);

export const IconShield = (p: P) => (
  <Svg {...p}>
    <path d="M10 2.5 3.5 5v4.5c0 4 2.7 7 6.5 8 3.8-1 6.5-4 6.5-8V5L10 2.5Z" />
    <path d="m7.3 10 1.9 1.9 3.6-3.8" />
  </Svg>
);

export const IconEthernet = (p: P) => (
  <Svg {...p}>
    <path d="M4 5.5h12v7.5h-3v2.5H7V13H4V5.5Z" />
    <path d="M7 8.5v1.5M9 8.5v1.5M11 8.5v1.5M13 8.5v1.5" />
  </Svg>
);

export const IconLogout = (p: P) => (
  <Svg {...p}>
    <path d="M8 3.5H5A1.5 1.5 0 0 0 3.5 5v10A1.5 1.5 0 0 0 5 16.5h3M12.5 13.5 16 10l-3.5-3.5M16 10H8" />
  </Svg>
);

export const IconExternal = (p: P) => (
  <Svg {...p}>
    <path d="M11 3.5h5.5V9M16.5 3.5 9 11M14 12v3.5a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1H8" />
  </Svg>
);

export const IconClose = (p: P) => (
  <Svg {...p}>
    <path d="m5 5 10 10M15 5 5 15" />
  </Svg>
);

export const IconSearch = (p: P) => (
  <Svg {...p}>
    <circle cx="9" cy="9" r="5.5" />
    <path d="m13 13 4 4" />
  </Svg>
);

export const IconPlus = (p: P) => (
  <Svg {...p}>
    <path d="M10 4v12M4 10h12" />
  </Svg>
);

export const IconTrash = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 5.5h13M8 5.5V4h4v1.5M5 5.5l.8 11h8.4l.8-11M8.5 8.5v5M11.5 8.5v5" />
  </Svg>
);

export const IconBlock = (p: P) => (
  <Svg {...p}>
    <circle cx="10" cy="10" r="7" />
    <path d="m5 5 10 10" />
  </Svg>
);

export const IconChevronRight = (p: P) => (
  <Svg {...p}>
    <path d="m8 5 5 5-5 5" />
  </Svg>
);

export const IconArrowDown = (p: P) => (
  <Svg {...p}>
    <path d="M10 4v12M5 11l5 5 5-5" />
  </Svg>
);

export const IconArrowUp = (p: P) => (
  <Svg {...p}>
    <path d="M10 16V4M5 9l5-5 5 5" />
  </Svg>
);

export const IconRouter = (p: P) => (
  <Svg {...p}>
    <rect x="2.5" y="10.5" width="15" height="5.5" rx="1.5" />
    <path d="M5.5 13.25h.01M8 13.25h.01M13 13.3h2M7 7.2a4.3 4.3 0 0 1 6 0M5 5a7.2 7.2 0 0 1 10 0" />
  </Svg>
);

export const IconLock = (p: P) => (
  <Svg {...p}>
    <rect x="4.5" y="9" width="11" height="8" rx="1.5" />
    <path d="M7 9V6.5a3 3 0 0 1 6 0V9" />
  </Svg>
);

/** WiFi signal strength in four bars, filled by RSSI. */
export function SignalBars({ dbm, class: cls }: { dbm: number; class?: string }) {
  const level = dbm >= -55 ? 4 : dbm >= -65 ? 3 : dbm >= -75 ? 2 : 1;
  const tone = level >= 3 ? 'text-ok' : level === 2 ? 'text-warn' : 'text-bad';
  return (
    <svg width="16" height="12" viewBox="0 0 16 12" aria-label={`${dbm} dBm`} role="img" class={`${tone} ${cls ?? ''}`}>
      {[0, 1, 2, 3].map((i) => (
        <rect
          key={i}
          x={i * 4}
          y={9 - i * 3}
          width="3"
          height={3 + i * 3}
          rx="0.75"
          fill="currentColor"
          opacity={i < level ? 1 : 0.2}
        />
      ))}
    </svg>
  );
}

/** netui mark for the rail: a rounded square with a stylised N. */
export const Logo = ({ size = 28 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true">
    <rect width="28" height="28" rx="7" fill="var(--accent)" />
    <path d="M8.5 19V9l11 10V9" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
);

export const IconTopology = (p: P) => (
  <Svg {...p}>
    <rect x="7.5" y="2.5" width="5" height="4" rx="1" />
    <rect x="2.5" y="13.5" width="5" height="4" rx="1" />
    <rect x="12.5" y="13.5" width="5" height="4" rx="1" />
    <path d="M10 6.5v3.5M5 13.5V10h10v3.5" />
  </Svg>
);

export const IconInsights = (p: P) => (
  <Svg {...p}>
    <path d="M3 17h14" />
    <path d="M5.5 14V9M10 14V4.5M14.5 14v-6" />
  </Svg>
);

export const IconPulse = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 10h3l2-5 3.5 10 2-5h4.5" />
  </Svg>
);

export const IconLog = (p: P) => (
  <Svg {...p}>
    <rect x="3.5" y="2.5" width="13" height="15" rx="2" />
    <path d="M7 7h6M7 10h6M7 13h3.5" />
  </Svg>
);

export const IconVpn = (p: P) => (
  <Svg {...p}>
    <path d="M10 2.5 4 5v4.5c0 3.6 2.5 6.8 6 8 3.5-1.2 6-4.4 6-8V5l-6-2.5Z" />
    <circle cx="10" cy="9" r="1.75" />
    <path d="M10 10.75V13" />
  </Svg>
);

export const IconRoute = (p: P) => (
  <Svg {...p}>
    <circle cx="5" cy="15" r="2" />
    <circle cx="15" cy="5" r="2" />
    <path d="M7 15h5.5a2.5 2.5 0 0 0 0-5h-5a2.5 2.5 0 0 1 0-5H13" />
  </Svg>
);

export const IconSystem = (p: P) => (
  <Svg {...p}>
    <rect x="5" y="5" width="10" height="10" rx="1.5" />
    <rect x="8" y="8" width="4" height="4" rx=".5" />
    <path d="M8 2.5V5M12 2.5V5M8 15v2.5M12 15v2.5M2.5 8H5M2.5 12H5M15 8h2.5M15 12h2.5" />
  </Svg>
);

export const IconBell = (p: P) => (
  <Svg {...p}>
    <path d="M5 13.5V9a5 5 0 0 1 10 0v4.5l1.5 1.5h-13L5 13.5Z" />
    <path d="M8.5 17.5h3" />
  </Svg>
);

export const IconQr = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="3" width="5.5" height="5.5" rx="1" />
    <rect x="11.5" y="3" width="5.5" height="5.5" rx="1" />
    <rect x="3" y="11.5" width="5.5" height="5.5" rx="1" />
    <path d="M11.5 11.5h2v2h-2zM15 15h2v2h-2zM15 11.5h2M11.5 15v2" />
  </Svg>
);

export const IconRefresh = (p: P) => (
  <Svg {...p}>
    <path d="M16 10a6 6 0 1 1-1.8-4.3" />
    <path d="M16 3.5v3.5h-3.5" />
  </Svg>
);

export const IconPower = (p: P) => (
  <Svg {...p}>
    <path d="M10 2.5v7" />
    <path d="M6 5.2a6 6 0 1 0 8 0" />
  </Svg>
);

// --- VPN
export const IconCopy = (p: P) => (
  <Svg {...p}>
    <rect x="7" y="7" width="10" height="10" rx="1.5" />
    <path d="M13 7V4.5A1.5 1.5 0 0 0 11.5 3h-7A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13H7" />
  </Svg>
);

export const IconDownload = (p: P) => (
  <Svg {...p}>
    <path d="M10 3v9.5M6 9l4 4 4-4" />
    <path d="M3.5 14.5v1a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5v-1" />
  </Svg>
);

// --- Clients / Insights: device types ----------------------------------------

export const IconPhone = (p: P) => (
  <Svg {...p}>
    <rect x="5.5" y="2.5" width="9" height="15" rx="2" />
    <path d="M9 15h2" />
  </Svg>
);

export const IconLaptop = (p: P) => (
  <Svg {...p}>
    <rect x="4" y="4.5" width="12" height="8.5" rx="1" />
    <path d="M2.5 15.5h15" />
  </Svg>
);

export const IconTv = (p: P) => (
  <Svg {...p}>
    <rect x="2.5" y="4" width="15" height="10" rx="1.5" />
    <path d="M7 17h6" />
  </Svg>
);

export const IconGamepad = (p: P) => (
  <Svg {...p}>
    <path d="M6 6.5h8a3.5 3.5 0 0 1 3.4 4.3l-.8 3.4a1.8 1.8 0 0 1-3.1.8L12 13.5H8l-1.5 1.5a1.8 1.8 0 0 1-3.1-.8l-.8-3.4A3.5 3.5 0 0 1 6 6.5Z" />
    <path d="M6.5 9v2.5M5.25 10.25h2.5M13 10h.01M14.5 11h.01" />
  </Svg>
);

export const IconSpeaker = (p: P) => (
  <Svg {...p}>
    <rect x="5" y="2.5" width="10" height="15" rx="2" />
    <circle cx="10" cy="11.5" r="2.5" />
    <path d="M10 6h.01" />
  </Svg>
);

export const IconChip = (p: P) => (
  <Svg {...p}>
    <rect x="5.5" y="5.5" width="9" height="9" rx="1.5" />
    <path d="M8 3v2.5M12 3v2.5M8 14.5V17M12 14.5V17M3 8h2.5M3 12h2.5M14.5 8H17M14.5 12H17" />
  </Svg>
);

export const IconCamera = (p: P) => (
  <Svg {...p}>
    <rect x="2.5" y="6" width="11" height="8" rx="1.5" />
    <path d="m13.5 9 4-2v6l-4-2" />
  </Svg>
);

export const IconPrinter = (p: P) => (
  <Svg {...p}>
    <path d="M6 7.5V3h8v4.5M6 14H4a1.5 1.5 0 0 1-1.5-1.5V9A1.5 1.5 0 0 1 4 7.5h12A1.5 1.5 0 0 1 17.5 9v3.5A1.5 1.5 0 0 1 16 14h-2" />
    <rect x="6" y="11.5" width="8" height="5.5" rx="1" />
  </Svg>
);

export const IconServer = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="3" width="14" height="6" rx="1.5" />
    <rect x="3" y="11" width="14" height="6" rx="1.5" />
    <path d="M6 6h.01M6 14h.01" />
  </Svg>
);

export const IconAccessPoint = (p: P) => (
  <Svg {...p}>
    <ellipse cx="10" cy="11.5" rx="7" ry="3" />
    <path d="M3 11.5V13c0 1.66 3.13 3 7 3s7-1.34 7-3v-1.5" />
    <path d="M7.5 6.5a3.5 3.5 0 0 1 5 0M5.5 4.5a6.5 6.5 0 0 1 9 0" />
  </Svg>
);
