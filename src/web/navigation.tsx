import {
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";

/**
 * Minimal history router. No router dependency is added; `pushState` plus the
 * `popstate` event is enough for the six frontend paths this app needs.
 */

export interface Location {
  pathname: string;
  search: string;
}

function readLocation(): Location {
  return { pathname: window.location.pathname, search: window.location.search };
}

export function navigate(to: string): void {
  const url = new URL(to, window.location.origin);
  const next = `${url.pathname}${url.search}`;
  if (next === `${window.location.pathname}${window.location.search}`) return;
  window.history.pushState({}, "", next);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function useLocation(): Location {
  const [location, setLocation] = useState<Location>(readLocation);
  useEffect(() => {
    const onChange = () => setLocation(readLocation());
    window.addEventListener("popstate", onChange);
    return () => window.removeEventListener("popstate", onChange);
  }, []);
  return location;
}

export function useQuery(): URLSearchParams {
  const { search } = useLocation();
  return new URLSearchParams(search);
}

interface LinkProps
  extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  to: string;
  children: ReactNode;
}

/** A real anchor that is also keyboard-operable and updates browser history. */
export function Link({ to, children, onClick, ...rest }: LinkProps) {
  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(event);
      if (event.defaultPrevented) return;
      if (
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      event.preventDefault();
      navigate(to);
    },
    [to, onClick],
  );
  return (
    <a href={to} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}
