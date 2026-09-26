import { SYSTEM_DARK_QUERY, THEME_MODES } from './types';
import { THEME_COOKIE_NAME } from './resolve';

/**
 * Inline script rendered as the first child of <body> by the root layout.
 *
 * It runs before the browser paints, so the very first frame already uses the
 * user's scheme — no flash of the wrong theme, even when the stored choice is
 * "system" and the server could only guess light. It is deliberately
 * dependency-free and wrapped in try/catch: a failure here must never break the
 * page, it just falls back to the server-rendered attributes.
 *
 * It is a no-op unless a valid cookie is present. That matters: when there is
 * no cookie the server may have resolved the scheme from the signed-in user's
 * `users.themeMode` column, and this must not overwrite that with the default.
 */
export function themeBootstrapScript(): string {
  // The cookie name is a compile-time constant, but escape it anyway so the
  // generated regular expression can never be broken by an edit upstream.
  const cookieName = THEME_COOKIE_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const modes = JSON.stringify(THEME_MODES);
  const query = JSON.stringify(SYSTEM_DARK_QUERY);

  return `(function(){try{var c=document.cookie.match(/(?:^|;\\s*)${cookieName}=([^;]*)/);if(!c)return;var v=decodeURIComponent(c[1]);if(${modes}.indexOf(v)<0)return;var d=v==="dark"||(v==="system"&&window.matchMedia(${query}).matches);var e=document.documentElement;e.setAttribute("data-theme-mode",v);e.setAttribute("data-theme",d?"dark":"light");e.style.colorScheme=d?"dark":"light";}catch(x){}})();`;
}
