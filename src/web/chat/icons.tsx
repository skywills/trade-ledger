import type { ReactNode } from "react";

/**
 * A handful of 20px stroke icons (Phosphor-style geometry, 1.75 stroke) drawn
 * inline so the app needs no icon dependency. Always decorative: callers put
 * the meaning in visible text or an aria-label.
 */
function Svg({ children }: { children: ReactNode }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const SparkleIcon = () => (
  <Svg>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.5 2.5M15.2 15.2l2.5 2.5M6.3 17.7l2.5-2.5M15.2 8.8l2.5-2.5" />
  </Svg>
);

export const SendIcon = () => (
  <Svg>
    <path d="M4 12 20 4l-6 16-2.5-6.5L4 12Z" />
  </Svg>
);

export const PaperclipIcon = () => (
  <Svg>
    <path d="m15.5 7-7.8 7.8a2.1 2.1 0 0 0 3 3l7.9-7.9a4.2 4.2 0 0 0-6-6L4.8 11.8a6.4 6.4 0 0 0 9 9L20 14.6" />
  </Svg>
);

export const PlusIcon = () => (
  <Svg>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const StopIcon = () => (
  <Svg>
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </Svg>
);

export const CheckIcon = () => (
  <Svg>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
);

export const XIcon = () => (
  <Svg>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);

export const ShieldIcon = () => (
  <Svg>
    <path d="M12 3 5 6v5.5c0 4.2 2.9 8 7 9.5 4.1-1.5 7-5.3 7-9.5V6l-7-3Z" />
    <path d="M12 9v4M12 16.5v.01" />
  </Svg>
);

export const WrenchIcon = () => (
  <Svg>
    <path d="M14.7 6.3a4 4 0 0 0 5 5l-8.4 8.4a2.1 2.1 0 0 1-3-3l8.4-8.4a4 4 0 0 0-2-2Z" />
  </Svg>
);

export const ListIcon = () => (
  <Svg>
    <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />
  </Svg>
);
