/**
 * Global light/dark theme.
 *
 * Stores the user's choice in localStorage under `bmu_theme` ('light'|'dark').
 * On first load with no preference saved, follows the OS preference
 * (`prefers-color-scheme: dark`).
 *
 * Each page can opt-in by:
 *   1. Including <script src="theme.js"></script> early (before paint), so
 *      the data-theme attribute is set before the first style pass and we
 *      avoid a flash of light theme.
 *   2. Optionally rendering a button with id="themeToggleBtn" — this script
 *      wires it up on DOMContentLoaded. Pages without the button still get
 *      the saved theme applied.
 *
 * Cosmetic only — no auth, no network calls.
 */
(function () {
    const KEY = 'bmu_theme';

    function preferredTheme() {
        try {
            const saved = localStorage.getItem(KEY);
            if (saved === 'light' || saved === 'dark') return saved;
        } catch (_) { /* localStorage unavailable */ }
        try {
            return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        } catch (_) {
            return 'light';
        }
    }

    function applyTheme(t) {
        const html = document.documentElement;
        html.setAttribute('data-theme', t);
        // Update the toggle icon if the button exists.
        const btn = document.getElementById('themeToggleBtn');
        if (btn) {
            const icon = btn.querySelector('i');
            if (icon) icon.className = t === 'dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
            btn.title = t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
        }
    }

    // Apply immediately (this script runs in <head> before paint).
    applyTheme(preferredTheme());

    function wire() {
        const btn = document.getElementById('themeToggleBtn');
        if (!btn) return;
        applyTheme(preferredTheme()); // refresh icon now that the button exists
        btn.addEventListener('click', () => {
            const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
            try { localStorage.setItem(KEY, next); } catch (_) { /* ignore */ }
            applyTheme(next);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wire, { once: true });
    } else {
        wire();
    }

    // If the toggle button is added dynamically (e.g. authSlot rendered after
    // login), re-wire on the next animation frame.
    const observer = new MutationObserver(() => {
        const btn = document.getElementById('themeToggleBtn');
        if (btn && !btn._bmuWired) {
            btn._bmuWired = true;
            wire();
        }
    });
    if (document.body) observer.observe(document.body, { childList: true, subtree: true });
    else document.addEventListener('DOMContentLoaded', () => observer.observe(document.body, { childList: true, subtree: true }), { once: true });
})();
